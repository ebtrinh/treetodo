<script>
  import { onMount } from 'svelte';

  // ---- Model -------------------------------------------------------------
  // A node is a todo: { id, text, done, x, y, parent }
  // The tree is defined by each node's `parent` (null = root). One parent,
  // many children. Cycles are prevented when re-parenting.

  let nodes = $state([]);
  let nextId = $state(1);
  let selectedId = $state(null);

  // Connection drag state: when the user grabs a node's handle we track the
  // pointer so we can draw a live "rubber band" and drop onto a target.
  let linking = $state(null); // { fromId, x, y }
  let hoverTargetId = $state(null);

  const STORAGE_KEY = 'tree-todo-v1';

  // ---- Persistence -------------------------------------------------------
  onMount(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        nodes = data.nodes ?? [];
        nextId = data.nextId ?? nodes.length + 1;
      }
    } catch (e) {
      console.warn('Could not load saved tree', e);
    }
    if (nodes.length === 0) seed();
  });

  $effect(() => {
    // Re-runs whenever nodes/nextId change.
    const data = JSON.stringify({ nodes, nextId });
    try {
      localStorage.setItem(STORAGE_KEY, data);
    } catch (e) {
      /* ignore quota errors */
    }
  });

  function seed() {
    nodes = [
      { id: 1, text: 'Plan the project', done: false, x: 420, y: 80, parent: null },
      { id: 2, text: 'Design the UI', done: false, x: 220, y: 260, parent: 1 },
      { id: 3, text: 'Build the backend', done: false, x: 620, y: 260, parent: 1 },
      { id: 4, text: 'Pick colors', done: true, x: 120, y: 440, parent: 2 }
    ];
    nextId = 5;
  }

  // ---- Node ops ----------------------------------------------------------
  function addNode(parent = null) {
    // Drop new nodes near the parent, or in the middle of the viewport.
    let x = 320 + Math.round((idHash(nextId) % 200) - 100);
    let y = 140;
    if (parent != null) {
      const p = nodes.find((n) => n.id === parent);
      if (p) {
        const siblings = nodes.filter((n) => n.parent === parent).length;
        x = p.x + siblings * 180 - 60;
        y = p.y + 160;
      }
    }
    const node = { id: nextId, text: 'New todo', done: false, x, y, parent };
    nodes = [...nodes, node];
    selectedId = nextId;
    nextId += 1;
  }

  // Deterministic pseudo-random spread so it survives SSR/hydration.
  function idHash(n) {
    return (n * 2654435761) >>> 8;
  }

  function deleteNode(id) {
    // Re-parent children up to the deleted node's parent so the tree stays connected.
    const target = nodes.find((n) => n.id === id);
    if (!target) return;
    nodes = nodes
      .filter((n) => n.id !== id)
      .map((n) => (n.parent === id ? { ...n, parent: target.parent } : n));
    if (selectedId === id) selectedId = null;
  }

  function toggleDone(id) {
    nodes = nodes.map((n) => (n.id === id ? { ...n, done: !n.done } : n));
  }

  function setText(id, text) {
    nodes = nodes.map((n) => (n.id === id ? { ...n, text } : n));
  }

  // Would making `parentId` the parent of `childId` create a cycle?
  function wouldCycle(childId, parentId) {
    let cur = parentId;
    while (cur != null) {
      if (cur === childId) return true;
      cur = nodes.find((n) => n.id === cur)?.parent ?? null;
    }
    return false;
  }

  function connect(childId, parentId) {
    if (childId === parentId) return;
    if (wouldCycle(parentId, childId)) return; // dropping a parent onto its own descendant
    nodes = nodes.map((n) => (n.id === childId ? { ...n, parent: parentId } : n));
  }

  function detach(id) {
    nodes = nodes.map((n) => (n.id === id ? { ...n, parent: null } : n));
  }

  function clearAll() {
    if (confirm('Delete every node?')) {
      nodes = [];
      nextId = 1;
    }
  }

  // ---- Dragging nodes ----------------------------------------------------
  let dragging = null; // { id, dx, dy }
  let canvasEl;

  function pointerInCanvas(e) {
    const r = canvasEl.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function startDrag(e, node) {
    if (e.button !== 0) return;
    selectedId = node.id;
    const p = pointerInCanvas(e);
    dragging = { id: node.id, dx: p.x - node.x, dy: p.y - node.y };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function startLink(e, node) {
    e.stopPropagation();
    const p = pointerInCanvas(e);
    linking = { fromId: node.id, x: p.x, y: p.y };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(e) {
    const p = pointerInCanvas(e);
    if (dragging) {
      nodes = nodes.map((n) =>
        n.id === dragging.id ? { ...n, x: p.x - dragging.dx, y: p.y - dragging.dy } : n
      );
    } else if (linking) {
      linking = { ...linking, x: p.x, y: p.y };
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const card = el?.closest('[data-node-id]');
      const tid = card ? Number(card.getAttribute('data-node-id')) : null;
      hoverTargetId = tid && tid !== linking.fromId ? tid : null;
    }
  }

  function onPointerUp() {
    if (linking && hoverTargetId != null) {
      // Drop the dragged node ONTO a target => target becomes the parent.
      connect(linking.fromId, hoverTargetId);
    }
    dragging = null;
    linking = null;
    hoverTargetId = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }

  // ---- Derived: edges + progress ----------------------------------------
  const nodeById = $derived(new Map(nodes.map((n) => [n.id, n])));

  const edges = $derived(
    nodes
      .filter((n) => n.parent != null && nodeById.has(n.parent))
      .map((n) => ({ from: nodeById.get(n.parent), to: n }))
  );

  const stats = $derived({
    total: nodes.length,
    done: nodes.filter((n) => n.done).length
  });

  // A subtree counts as "complete" for the ring if the node + all descendants done.
  function subtreeProgress(id) {
    const kids = nodes.filter((n) => n.parent === id);
    let total = 1;
    let done = nodeById.get(id)?.done ? 1 : 0;
    for (const k of kids) {
      const sub = subtreeProgress(k.id);
      total += sub.total;
      done += sub.done;
    }
    return { total, done };
  }

  // Anchor points for an edge (bottom of parent -> top of child).
  const NODE_W = 176;
  function edgePath(from, to) {
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + 74;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y;
    const my = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
  }
</script>

<svelte:head><title>Tree Todo</title></svelte:head>

<div class="app">
  <header>
    <h1>🌳 Tree&nbsp;Todo</h1>
    <div class="toolbar">
      <button class="primary" onclick={() => addNode(null)}>+ Add node</button>
      {#if selectedId != null}
        <button onclick={() => addNode(selectedId)}>+ Child of selected</button>
        <button onclick={() => detach(selectedId)}>Detach selected</button>
      {/if}
      <span class="spacer"></span>
      <span class="count">{stats.done}/{stats.total} done</span>
      <button class="ghost" onclick={clearAll}>Clear</button>
    </div>
    <p class="hint">
      Drag a card to move it. Drag from a card's <b>◦ handle</b> onto another card to make that
      card its <b>parent</b>. Click a card to select it.
    </p>
  </header>

  <div
    class="canvas"
    bind:this={canvasEl}
    onpointerdown={() => (selectedId = null)}
  >
    <!-- Edges -->
    <svg class="edges">
      {#each edges as e (e.to.id)}
        <path
          d={edgePath(e.from, e.to)}
          class:done={e.to.done}
          fill="none"
        />
      {/each}
      {#if linking}
        {@const from = nodeById.get(linking.fromId)}
        {#if from}
          <path
            class="linking"
            d={`M ${from.x + NODE_W / 2} ${from.y + 37} L ${linking.x} ${linking.y}`}
            fill="none"
          />
        {/if}
      {/if}
    </svg>

    <!-- Nodes -->
    {#each nodes as node (node.id)}
      {@const prog = subtreeProgress(node.id)}
      {@const complete = prog.done === prog.total}
      <div
        class="node"
        class:done={node.done}
        class:selected={selectedId === node.id}
        class:target={hoverTargetId === node.id}
        data-node-id={node.id}
        style="left:{node.x}px; top:{node.y}px"
        onpointerdown={(e) => {
          e.stopPropagation();
          startDrag(e, node);
        }}
      >
        <div class="row">
          <button
            class="check"
            class:on={node.done}
            title="Toggle done"
            onpointerdown={(e) => e.stopPropagation()}
            onclick={() => toggleDone(node.id)}
          >{node.done ? '✓' : ''}</button>

          <input
            class="text"
            value={node.text}
            onpointerdown={(e) => e.stopPropagation()}
            oninput={(e) => setText(node.id, e.currentTarget.value)}
          />

          <button
            class="del"
            title="Delete"
            onpointerdown={(e) => e.stopPropagation()}
            onclick={() => deleteNode(node.id)}
          >×</button>
        </div>

        <div class="meta">
          <span class="badge" class:complete>
            {prog.done}/{prog.total}
          </span>
          <!-- Connection handle: drag me onto another node -->
          <button
            class="handle"
            title="Drag onto another card to set its parent"
            onpointerdown={(e) => startLink(e, node)}
          >◦ connect</button>
        </div>
      </div>
    {/each}

    {#if nodes.length === 0}
      <div class="empty">No nodes yet — hit <b>+ Add node</b> to start your tree.</div>
    {/if}
  </div>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: #0f1220;
    color: #e7e9f3;
  }

  .app {
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  header {
    padding: 14px 20px 10px;
    border-bottom: 1px solid #262a40;
    background: #14172a;
    z-index: 3;
  }
  h1 {
    margin: 0 0 8px;
    font-size: 20px;
    letter-spacing: 0.3px;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .spacer {
    flex: 1;
  }
  .count {
    font-variant-numeric: tabular-nums;
    color: #9aa0c0;
    font-size: 13px;
  }
  .hint {
    margin: 8px 0 0;
    font-size: 12px;
    color: #8890b4;
  }
  .hint b {
    color: #c9cef0;
  }

  button {
    font: inherit;
    border: 1px solid #333856;
    background: #1c2036;
    color: #e7e9f3;
    padding: 6px 12px;
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover {
    background: #262b48;
  }
  button.primary {
    background: #4f6bff;
    border-color: #4f6bff;
    font-weight: 600;
  }
  button.primary:hover {
    background: #6079ff;
  }
  button.ghost {
    background: transparent;
  }

  .canvas {
    position: relative;
    flex: 1;
    overflow: auto;
    background:
      radial-gradient(circle at 1px 1px, #23273f 1px, transparent 0) 0 0 / 26px 26px;
    touch-action: none;
  }

  .edges {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
  }
  .edges path {
    stroke: #46507e;
    stroke-width: 2.5;
  }
  .edges path.done {
    stroke: #2f8f5b;
  }
  .edges path.linking {
    stroke: #4f6bff;
    stroke-width: 2.5;
    stroke-dasharray: 6 5;
  }

  .node {
    position: absolute;
    width: 176px;
    background: #1b1f36;
    border: 1px solid #313657;
    border-radius: 12px;
    padding: 10px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
    cursor: grab;
    user-select: none;
  }
  .node:active {
    cursor: grabbing;
  }
  .node.selected {
    border-color: #4f6bff;
    box-shadow: 0 0 0 2px rgba(79, 107, 255, 0.35), 0 6px 18px rgba(0, 0, 0, 0.4);
  }
  .node.target {
    border-color: #57d98a;
    box-shadow: 0 0 0 3px rgba(87, 217, 138, 0.4);
  }
  .node.done {
    opacity: 0.7;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .check {
    width: 22px;
    height: 22px;
    padding: 0;
    border-radius: 6px;
    color: #fff;
    font-size: 13px;
    flex: 0 0 auto;
  }
  .check.on {
    background: #2f8f5b;
    border-color: #2f8f5b;
  }
  .text {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    font-size: 14px;
    padding: 2px 0;
  }
  .text:focus {
    outline: none;
    border-bottom: 1px solid #4f6bff;
  }
  .node.done .text {
    text-decoration: line-through;
    color: #9aa0c0;
  }
  .del {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    padding: 0;
    line-height: 1;
    font-size: 16px;
    color: #ff9a9a;
    border-color: transparent;
    background: transparent;
  }
  .del:hover {
    background: #3a1f2a;
  }

  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }
  .badge {
    font-size: 11px;
    color: #9aa0c0;
    background: #14172a;
    border: 1px solid #2a2f4c;
    padding: 1px 7px;
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
  }
  .badge.complete {
    color: #7ff0ad;
    border-color: #2f8f5b;
  }
  .handle {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    cursor: crosshair;
    color: #b9c0ea;
  }
  .handle:hover {
    border-color: #4f6bff;
    color: #fff;
  }

  .empty {
    position: absolute;
    top: 40%;
    left: 0;
    right: 0;
    text-align: center;
    color: #6b7299;
    font-size: 15px;
  }
</style>
