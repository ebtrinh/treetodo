<script>
  import { onMount } from 'svelte';
  import { supabase, TREE_ID } from '$lib/supabase.js';

  // ---- Model -------------------------------------------------------------
  // Items live in one array. Two kinds:
  //   task: { id, kind:'task', text, done, x, y, deps:number[], w?, h? }
  //   note: { id, kind:'note', text, x, y, w?, h? }   (free-floating text box)
  // Dependencies form a DAG: `deps` lists the tasks that must be done BEFORE
  // this one (its prerequisites). A prerequisite can feed many dependents —
  // e.g. "get milk" can be a dep of both "ice cream" and "mac & cheese".
  // A task is completable only once every task in its `deps` is done.
  // `w`/`h` are optional manual sizes set by dragging the resize grip.

  let nodes = $state([]);
  let nextId = $state(1);
  let selectedId = $state(null);

  // Pan/zoom of the canvas "world".
  let view = $state({ x: 0, y: 0, scale: 1 });

  // Measured on-screen size of each card (id -> {w,h}); used to anchor edges.
  let dims = $state({});

  // Connection drag state: when the user grabs a task's handle we track the
  // pointer so we can draw a live "rubber band" and drop onto a target.
  let linking = $state(null); // { fromId, x, y }
  let hoverTargetId = $state(null);

  const STORAGE_KEY = 'tree-todo-v1';
  const DEFAULT_W = 200;
  const DEFAULT_H = 84;

  const isNote = (n) => n.kind === 'note';
  const isTask = (n) => n.kind !== 'note';

  // Normalize loaded data: ensure every task has a `deps` array and migrate
  // the old single-`parent` shape (child.parent = P  =>  P depends on child).
  function migrate(list) {
    if (!Array.isArray(list)) return [];
    const byId = new Map(list.map((n) => [n.id, n]));
    for (const n of list) if (!Array.isArray(n.deps)) n.deps = [];
    for (const n of list) {
      if (n.parent != null && byId.has(n.parent)) {
        const p = byId.get(n.parent);
        if (!p.deps.includes(n.id)) p.deps.push(n.id);
      }
      delete n.parent;
    }
    return list;
  }

  // ---- Persistence + Supabase sync --------------------------------------
  let loaded = false;
  let lastSynced = '';
  let saveTimer;

  onMount(() => {
    // Load the local cache first so the tree shows instantly / works offline.
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        nodes = migrate(data.nodes ?? []);
        nextId = data.nextId ?? nodes.length + 1;
        if (data.view) view = data.view;
      }
    } catch (e) {
      console.warn('Could not load saved tree', e);
    }
    init();
    canvasEl?.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      clearTimeout(saveTimer);
      canvasEl?.removeEventListener('wheel', onWheel);
    };
  });

  async function init() {
    if (supabase) {
      const { data, error } = await supabase
        .from('trees')
        .select('data')
        .eq('id', TREE_ID)
        .maybeSingle();

      if (!error && data?.data?.nodes) {
        nodes = migrate(data.data.nodes);
        nextId = data.data.nextId ?? nodes.length + 1;
        lastSynced = JSON.stringify({ nodes, nextId });
      } else if (nodes.length === 0) {
        seed();
      }

      // Live updates from other devices editing the same tree.
      supabase
        .channel('trees-sync')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'trees', filter: `id=eq.${TREE_ID}` },
          (payload) => {
            const d = payload.new?.data;
            if (!d?.nodes) return;
            const incoming = JSON.stringify({ nodes: d.nodes, nextId: d.nextId ?? nextId });
            if (incoming === lastSynced) return; // our own echo
            // Don't yank the tree out from under an in-progress interaction.
            if (dragging || resizing || linking || panning) return;
            lastSynced = incoming;
            nodes = migrate(d.nodes);
            nextId = d.nextId ?? nextId;
          }
        )
        .subscribe();
    } else if (nodes.length === 0) {
      seed();
    }
    loaded = true;
  }

  $effect(() => {
    // Re-runs whenever nodes/nextId/view change.
    const snapshot = { nodes, nextId, view };
    const payload = JSON.stringify({ nodes, nextId });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (e) {
      /* ignore quota errors */
    }
    if (!loaded || payload === lastSynced) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveRemote(payload), 400);
  });

  async function saveRemote(payload) {
    if (!supabase) return;
    lastSynced = payload;
    const body = JSON.parse(payload);
    const { error } = await supabase
      .from('trees')
      .upsert({ id: TREE_ID, data: body, updated_at: new Date().toISOString() });
    if (error) console.warn('Supabase save failed', error);
  }

  function seed() {
    // Demo of a shared prerequisite: "Get milk" unlocks two dishes.
    nodes = [
      { id: 1, kind: 'task', text: 'Get milk', done: false, x: 360, y: 80, deps: [] },
      { id: 2, kind: 'task', text: 'Make ice cream', done: false, x: 160, y: 300, deps: [1] },
      { id: 3, kind: 'task', text: 'Make mac & cheese', done: false, x: 560, y: 300, deps: [1] },
      { id: 4, kind: 'task', text: 'Serve dinner', done: false, x: 360, y: 520, deps: [2, 3] }
    ];
    nextId = 5;
  }

  // ---- Node ops ----------------------------------------------------------
  function addNode(parent = null) {
    let x, y;
    if (parent != null) {
      const p = nodeById.get(parent);
      const count = p?.deps?.length ?? 0;
      x = (p?.x ?? 0) + count * 200 - 60;
      y = (p?.y ?? 0) - 180; // a prerequisite sits above the task it unlocks
    } else {
      const c = viewCenterWorld();
      x = c.x - DEFAULT_W / 2;
      y = c.y - DEFAULT_H / 2;
    }
    const id = nextId;
    let next = [...nodes, { id, kind: 'task', text: 'New todo', done: false, x, y, deps: [] }];
    if (parent != null) {
      // The new task becomes a prerequisite of the selected task.
      next = next.map((n) => (n.id === parent ? { ...n, deps: [...(n.deps ?? []), id] } : n));
    }
    nodes = next;
    selectedId = id;
    nextId += 1;
  }

  function addNote() {
    const c = viewCenterWorld();
    const node = { id: nextId, kind: 'note', text: 'Text', x: c.x - 90, y: c.y - 24 };
    nodes = [...nodes, node];
    selectedId = nextId;
    nextId += 1;
  }

  function deleteNode(id) {
    nodes = nodes
      .filter((n) => n.id !== id)
      .map((n) => ((n.deps ?? []).includes(id) ? { ...n, deps: n.deps.filter((d) => d !== id) } : n));
    if (selectedId === id) selectedId = null;
  }

  // Direct prerequisites of a task.
  function prereqs(id) {
    return (nodeById.get(id)?.deps ?? []).map((d) => nodeById.get(d)).filter(Boolean);
  }
  function canComplete(id) {
    return prereqs(id).every((d) => d.done);
  }
  // "Inaccessible": not done yet and still waiting on unfinished prerequisites.
  function isBlocked(id) {
    const n = nodeById.get(id);
    return n ? !n.done && !canComplete(id) : false;
  }

  // Tasks that list `id` among their prerequisites.
  function dependentsOf(id) {
    return nodes.filter((n) => (n.deps ?? []).includes(id));
  }

  function toggleDone(id) {
    const node = nodeById.get(id);
    if (!node) return;
    if (!node.done) {
      if (!canComplete(id)) return; // locked until every prerequisite is done
      nodes = nodes.map((n) => (n.id === id ? { ...n, done: true } : n));
    } else {
      // Un-completing breaks the chain, so anything depending on it can't stay done.
      const undo = new Set();
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        if (undo.has(cur)) continue;
        undo.add(cur);
        for (const dep of dependentsOf(cur)) stack.push(dep.id);
      }
      nodes = nodes.map((n) => (undo.has(n.id) ? { ...n, done: false } : n));
    }
  }

  function setText(id, text) {
    nodes = nodes.map((n) => (n.id === id ? { ...n, text } : n));
  }

  // Can `start` reach `target` by following prerequisite links?
  function reachable(start, target) {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of nodeById.get(cur)?.deps ?? []) stack.push(d);
    }
    return false;
  }

  // Make `prereqId` a prerequisite of `dependentId`.
  function connect(prereqId, dependentId) {
    if (prereqId === dependentId) return;
    const dep = nodeById.get(dependentId);
    const pre = nodeById.get(prereqId);
    if (!dep || !pre || isNote(dep) || isNote(pre)) return; // notes never link
    if ((dep.deps ?? []).includes(prereqId)) return; // already connected
    if (reachable(prereqId, dependentId)) return; // would create a cycle
    nodes = nodes.map((n) =>
      n.id === dependentId ? { ...n, deps: [...(n.deps ?? []), prereqId] } : n
    );
  }

  // Fully disconnect a node (drop its prereqs and remove it from others').
  function detach(id) {
    nodes = nodes.map((n) => {
      if (n.id === id) return { ...n, deps: [] };
      if ((n.deps ?? []).includes(id)) return { ...n, deps: n.deps.filter((d) => d !== id) };
      return n;
    });
  }

  function clearAll() {
    if (confirm('Delete every node?')) {
      nodes = [];
      nextId = 1;
    }
  }

  // ---- Pointer / drag / resize / pan ------------------------------------
  let dragging = null; // { id, dx, dy }
  let resizing = null; // { id, sx, sy, w, h }
  let panning = null; // { sx, sy, ox, oy }
  let canvasEl;

  // Convert a screen event to world (pre-transform) coordinates.
  function pointerInWorld(e) {
    const r = canvasEl.getBoundingClientRect();
    return {
      x: (e.clientX - r.left - view.x) / view.scale,
      y: (e.clientY - r.top - view.y) / view.scale
    };
  }

  function viewCenterWorld() {
    const r = canvasEl.getBoundingClientRect();
    return { x: (r.width / 2 - view.x) / view.scale, y: (r.height / 2 - view.y) / view.scale };
  }

  function startDrag(e, node) {
    if (e.button !== 0) return;
    selectedId = node.id;
    const p = pointerInWorld(e);
    dragging = { id: node.id, dx: p.x - node.x, dy: p.y - node.y };
    addPointerListeners();
  }

  function startLink(e, node) {
    e.stopPropagation();
    const p = pointerInWorld(e);
    linking = { fromId: node.id, x: p.x, y: p.y };
    addPointerListeners();
  }

  function startResize(e, node) {
    e.stopPropagation();
    if (e.button !== 0) return;
    const p = pointerInWorld(e);
    const d = dims[node.id] ?? { w: DEFAULT_W, h: DEFAULT_H };
    resizing = { id: node.id, sx: p.x, sy: p.y, w: node.w ?? d.w, h: node.h ?? d.h };
    addPointerListeners();
  }

  function startPan(e) {
    if (e.button !== 0) return;
    selectedId = null;
    panning = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    addPointerListeners();
  }

  function addPointerListeners() {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(e) {
    if (panning) {
      view = { ...view, x: panning.ox + (e.clientX - panning.sx), y: panning.oy + (e.clientY - panning.sy) };
      return;
    }
    const p = pointerInWorld(e);
    if (resizing) {
      const w = Math.max(120, Math.round(resizing.w + (p.x - resizing.sx)));
      const h = Math.max(48, Math.round(resizing.h + (p.y - resizing.sy)));
      nodes = nodes.map((n) => (n.id === resizing.id ? { ...n, w, h } : n));
    } else if (dragging) {
      nodes = nodes.map((n) =>
        n.id === dragging.id ? { ...n, x: p.x - dragging.dx, y: p.y - dragging.dy } : n
      );
    } else if (linking) {
      linking = { ...linking, x: p.x, y: p.y };
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const card = el?.closest('[data-node-id]');
      const tid = card ? Number(card.getAttribute('data-node-id')) : null;
      const target = tid != null ? nodeById.get(tid) : null;
      hoverTargetId = target && isTask(target) && tid !== linking.fromId ? tid : null;
    }
  }

  function onPointerUp() {
    if (linking && hoverTargetId != null) {
      // Dropped the dragged card onto a target => this card is its prerequisite.
      connect(linking.fromId, hoverTargetId);
    }
    dragging = null;
    resizing = null;
    linking = null;
    panning = null;
    hoverTargetId = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }

  // ---- Zoom --------------------------------------------------------------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function zoomAt(factor, clientX, clientY) {
    const r = canvasEl.getBoundingClientRect();
    const mx = clientX - r.left;
    const my = clientY - r.top;
    const s = clamp(view.scale * factor, 0.25, 3);
    const wx = (mx - view.x) / view.scale;
    const wy = (my - view.y) / view.scale;
    view = { scale: s, x: mx - wx * s, y: my - wy * s };
  }

  function onWheel(e) {
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }

  function zoomButton(factor) {
    const r = canvasEl.getBoundingClientRect();
    zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  function resetView() {
    view = { x: 0, y: 0, scale: 1 };
  }

  // ---- Actions -----------------------------------------------------------
  // Grow a textarea to fit all of its text (no scrollbar, no clipping).
  function autogrow(el) {
    const resize = () => {
      el.style.height = '0px';
      el.style.height = el.scrollHeight + 'px';
    };
    const raf = () => requestAnimationFrame(resize);
    raf();
    el.addEventListener('input', raf);
    return {
      update() {
        raf();
      },
      destroy() {
        el.removeEventListener('input', raf);
      }
    };
  }

  // Track a card's rendered size so edges anchor to its real edges.
  function measure(el, id) {
    const update = () => {
      dims = { ...dims, [id]: { w: el.offsetWidth, h: el.offsetHeight } };
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return { destroy: () => ro.disconnect() };
  }

  // ---- Derived: edges + progress ----------------------------------------
  const nodeById = $derived(new Map(nodes.map((n) => [n.id, n])));

  // One edge per (prerequisite -> dependent) link. `from` = prerequisite.
  const edges = $derived(
    nodes.flatMap((n) =>
      isTask(n)
        ? (n.deps ?? [])
            .filter((d) => nodeById.has(d))
            .map((d) => ({ from: nodeById.get(d), to: n }))
        : []
    )
  );

  const stats = $derived({
    total: nodes.filter(isTask).length,
    done: nodes.filter((n) => isTask(n) && n.done).length
  });

  // Progress over a task and all of its (unique) transitive prerequisites.
  function subtreeProgress(id) {
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of nodeById.get(cur)?.deps ?? []) stack.push(d);
    }
    let total = 0;
    let done = 0;
    for (const nid of seen) {
      const n = nodeById.get(nid);
      if (!n) continue;
      total += 1;
      if (n.done) done += 1;
    }
    return { total, done };
  }

  // Anchor points for an edge: bottom-center of prerequisite -> top-center of dependent.
  function edgePath(from, to) {
    const fd = dims[from.id] ?? { w: DEFAULT_W, h: DEFAULT_H };
    const td = dims[to.id] ?? { w: DEFAULT_W, h: DEFAULT_H };
    const x1 = from.x + fd.w / 2;
    const y1 = from.y + fd.h;
    const x2 = to.x + td.w / 2;
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
      <button onclick={addNote}>+ Text box</button>
      {#if selectedId != null}
        <button onclick={() => addNode(selectedId)}>+ Prerequisite of selected</button>
        <button onclick={() => detach(selectedId)}>Detach selected</button>
      {/if}
      <span class="spacer"></span>
      <div class="zoom">
        <button onclick={() => zoomButton(1 / 1.2)} title="Zoom out">−</button>
        <span class="zval">{Math.round(view.scale * 100)}%</span>
        <button onclick={() => zoomButton(1.2)} title="Zoom in">+</button>
        <button onclick={resetView} title="Reset view">⤢</button>
      </div>
      <span class="count">{stats.done}/{stats.total} done</span>
      <button class="ghost" onclick={clearAll}>Clear</button>
    </div>
    <p class="hint">
      Drag empty space to <b>pan</b>, scroll to <b>zoom</b>. Drag a card to move it, or its
      <b>bottom-right grip</b> to resize. Drag a card's <b>◦ handle</b> onto another to make this
      card a <b>prerequisite</b> of it — one card can unlock many, and a card only unlocks once
      every prerequisite is done.
    </p>
  </header>

  <div
    class="canvas"
    bind:this={canvasEl}
    onpointerdown={startPan}
    style="background-position: {view.x}px {view.y}px; background-size: {26 * view.scale}px {26 * view.scale}px"
  >
    <div
      class="world"
      style="transform: translate({view.x}px, {view.y}px) scale({view.scale})"
    >
      <!-- Edges -->
      <svg class="edges">
        {#each edges as e (`${e.from.id}-${e.to.id}`)}
          <path d={edgePath(e.from, e.to)} class:done={e.from.done} fill="none" />
        {/each}
        {#if linking}
          {@const from = nodeById.get(linking.fromId)}
          {#if from}
            {@const fd = dims[from.id] ?? { w: DEFAULT_W, h: DEFAULT_H }}
            <path
              class="linking"
              d={`M ${from.x + fd.w / 2} ${from.y + fd.h / 2} L ${linking.x} ${linking.y}`}
              fill="none"
            />
          {/if}
        {/if}
      </svg>

      <!-- Nodes -->
      {#each nodes as node (node.id)}
        {#if isNote(node)}
          <div
            class="note"
            class:selected={selectedId === node.id}
            data-node-id={node.id}
            use:measure={node.id}
            style="left:{node.x}px; top:{node.y}px; width:{node.w ?? 180}px; min-height:{node.h ?? 44}px"
            onpointerdown={(e) => {
              e.stopPropagation();
              startDrag(e, node);
            }}
          >
            <textarea
              class="text"
              rows="1"
              value={node.text}
              use:autogrow={[node.text, node.w]}
              onpointerdown={(e) => e.stopPropagation()}
              oninput={(e) => setText(node.id, e.currentTarget.value)}
            ></textarea>
            <button
              class="del note-del"
              title="Delete"
              onpointerdown={(e) => e.stopPropagation()}
              onclick={() => deleteNode(node.id)}
            >×</button>
            <div class="grip" title="Drag to resize" onpointerdown={(e) => startResize(e, node)}></div>
          </div>
        {:else}
          {@const prog = subtreeProgress(node.id)}
          {@const complete = prog.done === prog.total}
          {@const blocked = isBlocked(node.id)}
          <div
            class="node"
            class:done={node.done}
            class:dim={node.done || blocked}
            class:selected={selectedId === node.id}
            class:target={hoverTargetId === node.id}
            data-node-id={node.id}
            use:measure={node.id}
            style="left:{node.x}px; top:{node.y}px; width:{node.w ?? DEFAULT_W}px; min-height:{node.h ?? DEFAULT_H}px"
            onpointerdown={(e) => {
              e.stopPropagation();
              startDrag(e, node);
            }}
          >
            <div class="row">
              <button
                class="check"
                class:on={node.done}
                class:locked={blocked}
                disabled={blocked}
                title={blocked ? 'Complete its prerequisite tasks first' : 'Toggle done'}
                onpointerdown={(e) => e.stopPropagation()}
                onclick={() => toggleDone(node.id)}
              >{node.done ? '✓' : blocked ? '🔒' : ''}</button>

              <textarea
                class="text"
                rows="1"
                value={node.text}
                use:autogrow={[node.text, node.w]}
                onpointerdown={(e) => e.stopPropagation()}
                oninput={(e) => setText(node.id, e.currentTarget.value)}
              ></textarea>

              <button
                class="del"
                title="Delete"
                onpointerdown={(e) => e.stopPropagation()}
                onclick={() => deleteNode(node.id)}
              >×</button>
            </div>

            <div class="meta">
              <span class="badge" class:complete>{prog.done}/{prog.total}</span>
              <button
                class="handle"
                title="Drag onto another card to make this its prerequisite"
                onpointerdown={(e) => startLink(e, node)}
              >◦ connect</button>
            </div>

            <div class="grip" title="Drag to resize" onpointerdown={(e) => startResize(e, node)}></div>
          </div>
        {/if}
      {/each}
    </div>

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
  .zoom {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .zoom button {
    padding: 4px 9px;
  }
  .zval {
    font-variant-numeric: tabular-nums;
    color: #9aa0c0;
    font-size: 12px;
    min-width: 38px;
    text-align: center;
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
    overflow: hidden;
    background:
      radial-gradient(circle at 1px 1px, #23273f 1px, transparent 0) 0 0 / 26px 26px;
    touch-action: none;
    cursor: grab;
  }
  .canvas:active {
    cursor: grabbing;
  }

  .world {
    position: absolute;
    inset: 0;
    transform-origin: 0 0;
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

  .node,
  .note {
    position: absolute;
    box-sizing: border-box;
    border-radius: 12px;
    cursor: grab;
    user-select: none;
    display: flex;
    flex-direction: column;
  }
  .node:active,
  .note:active {
    cursor: grabbing;
  }

  .node {
    background: #1b1f36;
    border: 1px solid #313657;
    padding: 10px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  }
  .node.selected,
  .note.selected {
    border-color: #4f6bff;
    box-shadow: 0 0 0 2px rgba(79, 107, 255, 0.35), 0 6px 18px rgba(0, 0, 0, 0.4);
  }
  .node.target {
    border-color: #57d98a;
    box-shadow: 0 0 0 3px rgba(87, 217, 138, 0.4);
  }
  /* Completed or blocked (inaccessible) tasks read as dimmer. */
  .node.dim {
    filter: brightness(0.72);
  }

  /* Text box: just the text, an outline, and an x. */
  .note {
    background: rgba(20, 23, 42, 0.6);
    border: 1px dashed #3a4066;
    padding: 6px 22px 6px 8px;
    box-shadow: none;
  }
  .note .text {
    font-size: 13px;
  }
  .note-del {
    position: absolute;
    top: 2px;
    right: 2px;
  }

  .row {
    display: flex;
    align-items: flex-start;
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
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .check.on {
    background: #2f8f5b;
    border-color: #2f8f5b;
  }
  .check.locked {
    cursor: not-allowed;
    font-size: 11px;
  }
  .check:disabled {
    opacity: 0.9;
  }
  .text {
    flex: 1;
    min-width: 0;
    width: 100%;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    font-size: 14px;
    padding: 2px 0;
    resize: none;
    overflow: hidden;
    line-height: 1.35;
  }
  .text:focus {
    outline: none;
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

  .grip {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    border-right: 2px solid #4b5382;
    border-bottom: 2px solid #4b5382;
    border-bottom-right-radius: 10px;
    opacity: 0.6;
  }
  .grip:hover {
    opacity: 1;
    border-color: #4f6bff;
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
