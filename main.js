document.addEventListener('DOMContentLoaded', () => {
    const canvasContainer = document.getElementById('canvas-container');
    const contextMenu = document.getElementById('context-menu');
    const canvasContextMenu = document.getElementById('canvas-context-menu');

    let blocks = {};
    let lines = [];
    let blockCounter = 0;
    let lineDrawingState = { startHandle: null, ghostLine: null };
    let isDeleteMode = false;
    let contextTarget = null;
    let clipboard = null; // 복사된 블록 데이터 저장
    let lastContextMenuPos = { x: 0, y: 0 }; // 붙여넣기 위치 저장

    /* =========================================================
     * 🔧 1. 공통 스타일 주입 (선 삭제 가능 + 커서 표시)
     * ========================================================= */
    const ensureDeleteStyle = () => {
        if (!document.getElementById('line-delete-style')) {
            const st = document.createElement('style');
            st.id = 'line-delete-style';
            st.textContent = `
            svg.leader-line.line-deletable {
                cursor: pointer !important;
            }
            svg.leader-line.line-deletable .leader-line-path,
            svg.leader-line.line-deletable .leader-line-arrow {
                pointer-events: stroke !important;
            }
            `;
            document.head.appendChild(st);
        }
    };
    ensureDeleteStyle();

    /* =========================================================
     * 🔧 2. 고스트(임시) 선 정리 유틸리티
     * ========================================================= */
    const cancelGhostLine = () => {
        if (lineDrawingState.ghostLine) {
            try { lineDrawingState.ghostLine.remove(); } catch (_) {}
            lineDrawingState.ghostLine = null;
        }
        lineDrawingState.startHandle = null;
    };

    /* =========================================================
     * 3. 블록(기본·분기) 생성
     * ========================================================= */
    function createBlock(id, x, y, width, height, type = 'default', data = {}) {
        const blockEl = document.createElement('div');
        blockEl.id = id;
        blockEl.className = `block ${type}-block`;
        blockEl.style.left = `${x}px`;
        blockEl.style.top = `${y}px`;
        blockEl.style.width = `${width}px`;
        if (height) blockEl.style.height = `${height}px`;
        if (data.color) blockEl.style.backgroundColor = data.color;

        blockEl.setAttribute('data-x', x);
        blockEl.setAttribute('data-y', y);

        const topContainer = document.createElement('div');
        topContainer.className = 'flex-grow w-full flex flex-col items-center justify-center';

        const labelWrapper = document.createElement('div');
        labelWrapper.className = 'block-input-wrapper';

        const label = document.createElement('div');
        label.className = 'block-label';
        label.textContent = data.label || `블록 ${id.split('-')[1]}`;
        if (data.fontSize) label.style.fontSize = data.fontSize;

        labelWrapper.appendChild(label);
        topContainer.appendChild(labelWrapper);

        let branchesContainer;
        if (type === 'branch') {
            branchesContainer = document.createElement('div');
            branchesContainer.className = 'branches-container mt-2';
            topContainer.appendChild(branchesContainer);
        }

        blockEl.appendChild(topContainer);

        const bottomContainer = document.createElement('div');
        if (type === 'branch') {
            const addBranchBtn = document.createElement('button');
            addBranchBtn.className = 'add-branch-btn';
            addBranchBtn.textContent = '+ 분기 추가';
            addBranchBtn.onclick = (e) => {
                e.stopPropagation();
                const newBranchId = `branch-${Date.now()}`;
                blocks[id].branches.push({ id: newBranchId, text: '새 조건' });
                addBranchToBlock(id, newBranchId, '새 조건');
            };
            bottomContainer.appendChild(addBranchBtn);
        }
        blockEl.appendChild(bottomContainer);

        canvasContainer.appendChild(blockEl);

        if (!blocks[id]) {
            blocks[id] = {
                el: blockEl, x, y, width,
                height: blockEl.offsetHeight, type,
                label: label.textContent, color: data.color || null, fontSize: data.fontSize || null,
                branches: type === 'branch' ? data.branches || [{ id: `branch-${Date.now()}`, text: '조건 1' }] : [],
            };
        }

        if (type === 'branch') {
            const branchesToCreate = data.branches || blocks[id].branches;
            blocks[id].branches = branchesToCreate;
            branchesToCreate.forEach((branchData) => {
                addBranchToBlock(id, branchData.id, branchData.text);
            });
        }

        ['top', 'right', 'bottom', 'left'].forEach((pos) => {
            const handle = document.createElement('div');
            handle.className = `handle handle-${pos}`;
            handle.dataset.blockId = id;
            handle.dataset.handleId = pos;
            blockEl.appendChild(handle);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-block-btn';
        deleteBtn.innerHTML = '&times;';
        deleteBtn.onclick = (e) => { e.stopPropagation(); deleteBlock(id); };
        blockEl.appendChild(deleteBtn);

        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'resize-handle';
        blockEl.appendChild(resizeHandle);

        setupBlockInteractions(blockEl);
        autoResizeBlock(id);
        return blockEl;
    }

    /* =========================================================
     * 4. 블록/브랜치 삭제 로직
     * ========================================================= */
    function deleteBlock(blockId, force = false) {
        if (!isDeleteMode && !force) return; // [MODIFIED] 강제 삭제가 아니고, 삭제 모드가 아니면 실행 안함

        lines = lines.filter((line) => {
            if (line.sourceBlock === blockId || line.targetBlock === blockId) {
                line.instance?.remove();
                return false;
            }
            return true;
        });
        blocks[blockId]?.el.remove();
        delete blocks[blockId];
        updateLines();
    }

    function deleteBranch(blockId, branchId) {
        if (!isDeleteMode) return;
        lines = lines.filter((line) => {
            const srcHit = line.sourceBlock === blockId && line.sourceHandle.startsWith(branchId);
            const tgtHit = line.targetBlock === blockId && line.targetHandle.startsWith(branchId);
            if (srcHit || tgtHit) {
                line.instance?.remove();
                return false;
            }
            return true;
        });
        const block = blocks[blockId];
        block.branches = block.branches.filter((b) => b.id !== branchId);
        block.el.querySelector(`.branch[data-branch-id="${branchId}"]`)?.remove();
        autoResizeBlock(blockId);
    }

    /* =========================================================
     * 5. 브랜치 추가 / 블록 자동 높이 조정
     * ========================================================= */
    function addBranchToBlock(blockId, branchId, text) {
        const blockEl = blocks[blockId].el;
        const branchContainer = blockEl.querySelector('.branches-container');
        const branchDiv = document.createElement('div');
        branchDiv.className = 'branch';
        branchDiv.dataset.branchId = branchId;

        const branchInput = document.createElement('input');
        branchInput.type = 'text';
        branchInput.className = 'branch-input';
        branchInput.value = text;
        branchInput.onclick = (e) => e.stopPropagation();
        branchInput.oninput = () => {
            const branch = blocks[blockId].branches.find((b) => b.id === branchId);
            if (branch) branch.text = branchInput.value;
        };

        const leftHandle = document.createElement('div');
        leftHandle.className = 'handle handle-left';
        leftHandle.dataset.blockId = blockId;
        leftHandle.dataset.handleId = `${branchId}-left`;

        const rightHandle = document.createElement('div');
        rightHandle.className = 'handle handle-right';
        rightHandle.dataset.blockId = blockId;
        rightHandle.dataset.handleId = `${branchId}-right`;

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-branch-btn';
        deleteBtn.innerHTML = '&times;';
        deleteBtn.onclick = (e) => { e.stopPropagation(); deleteBranch(blockId, branchId); };

        branchDiv.appendChild(leftHandle);
        branchDiv.appendChild(branchInput);
        branchDiv.appendChild(rightHandle);
        branchDiv.appendChild(deleteBtn);
        branchContainer.appendChild(branchDiv);

        setupBlockInteractions(branchDiv);
        autoResizeBlock(blockId);
    }

    function autoResizeBlock(blockId) {
        const block = blocks[blockId];
        if (!block) return;
        const blockEl = block.el;
        blockEl.style.height = 'auto';
        const preferred = blockEl.scrollHeight;
        const min = block.type === 'branch' ? 140 : 80;
        blockEl.style.height = `${Math.max(min, preferred)}px`;
        block.height = blockEl.offsetHeight;
        updateLines();
    }

    /* =========================================================
     * 6. 블록 추가 버튼 헬퍼
     * ========================================================= */
    function addNewBlock(type) {
        blockCounter += 1;
        const id = `block-${blockCounter}`;
        const offset = Object.keys(blocks).length % 5;
        const x = 50 + offset * 20;
        const y = 50 + offset * 20;
        const width = type === 'branch' ? 220 : 180;
        createBlock(id, x, y, width, null, type,
            type === 'branch' ? { label: '조건 분기' } : { label: `일반 블록 ${blockCounter}` }
        );
    }

    /* =========================================================
     * 7. 인터랙션 세팅
     * ========================================================= */
    function setupBlockInteractions(el) {
        const label = el.querySelector('.block-label');
        if (label) {
            label.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const blockEl = el.closest('.block');
                if (!blockEl) return;

                const wrapper = label.parentElement;
                const textarea = document.createElement('textarea');
                textarea.className = 'block-input';
                textarea.value = label.textContent;
                label.style.display = 'none';
                wrapper.appendChild(textarea);

                const autosize = () => {
                    textarea.style.height = 'auto';
                    textarea.style.height = `${textarea.scrollHeight}px`;
                    autoResizeBlock(blockEl.id);
                };
                textarea.addEventListener('input', autosize);

                textarea.focus();
                autosize();

                const finish = () => {
                    label.textContent = textarea.value;
                    blocks[blockEl.id].label = textarea.value;
                    label.style.display = 'flex';
                    textarea.remove();
                    autoResizeBlock(blockEl.id);
                };
                textarea.addEventListener('blur', finish);
                textarea.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter' && !ev.shiftKey) {
                        ev.preventDefault();
                        finish();
                    }
                });
            });
        }

        el.querySelectorAll('.handle').forEach((handle) => {
            handle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                if (isDeleteMode) return;
                cancelGhostLine();
                lineDrawingState.startHandle = e.currentTarget;

                lineDrawingState.ghostLine = new LeaderLine(
                    lineDrawingState.startHandle,
                    LeaderLine.pointAnchor({ x: e.clientX, y: e.clientY }),
                    { color: 'rgba(255,255,100,0.7)', size: 3, dash: { animation: true } }
                );

                lineDrawingState.ghostLine.path?.parentElement?.style.setProperty('pointer-events', 'none');
            });
        });
    }

    document.body.addEventListener('mousemove', (e) => {
        if (lineDrawingState.ghostLine) {
            lineDrawingState.ghostLine.end = LeaderLine.pointAnchor({ x: e.clientX, y: e.clientY });
        }
    });

    document.body.addEventListener('mouseup', (e) => {
        if (lineDrawingState.ghostLine) {
            try { lineDrawingState.ghostLine.remove(); } catch (_) {}
        }

        const startHandle = lineDrawingState.startHandle;
        if (startHandle) {
            const endEl = document.elementFromPoint(e.clientX, e.clientY);
            const endHandle = endEl?.closest('.handle');

            if (endHandle && startHandle !== endHandle && startHandle.dataset.blockId !== endHandle.dataset.blockId) {
                const sourceBlockId = startHandle.dataset.blockId;
                const sourceHandleId = startHandle.dataset.handleId;
                const targetBlockId = endHandle.dataset.blockId;
                const targetHandleId = endHandle.dataset.handleId;

                const exists = lines.some((l) =>
                    l.sourceBlock === sourceBlockId && l.sourceHandle === sourceHandleId &&
                    l.targetBlock === targetBlockId && l.targetHandle === targetHandleId
                );

                if (!exists) {
                    const lineId = `line-${Date.now()}`;
                    const leader = new LeaderLine(startHandle, endHandle, {
                        color: 'rgba(255,255,255,0.7)', size: 3,
                        path: 'fluid', endPlug: 'arrow1',
                    });
                    lines.push({
                        instance: leader, id: lineId,
                        sourceBlock: sourceBlockId, sourceHandle: sourceHandleId,
                        targetBlock: targetBlockId, targetHandle: targetHandleId,
                        color: null,
                    });
                    setTimeout(updateLineDeleteListeners, 0);
                }
            }
        }
        cancelGhostLine();
    });

    window.addEventListener('mouseleave', cancelGhostLine);

    /* =========================================================
     * 8. 선 위치 실시간 업데이트
     * ========================================================= */
    function updateLines() {
        lines.forEach((l) => { try { l.instance?.position(); } catch (_) {} });
    }

    /* =========================================================
 * 9. 삭제 모드용 선 클릭 리스너 관리  💖
 /* =========================================================
 /* =========================================================
 * 9. 삭제 모드용 선 클릭/핀 관리 (전면 교체)
 * ========================================================= */
function positionDeleteBtn(line) {
  const btn = line.deleteBtn;
  if (!btn) return;

  const srcBox = line.instance.start.getBoundingClientRect();
  const tgtBox = line.instance.end.getBoundingClientRect();
  const midX = (srcBox.left + srcBox.right + tgtBox.left + tgtBox.right) / 4;
  const midY = (srcBox.top + srcBox.bottom + tgtBox.top + tgtBox.bottom) / 4;
  btn.style.left = `${midX}px`;
  btn.style.top  = `${midY}px`;
}

function updateLineDeleteListeners() {
  lines.forEach((line) => {
    // ───── 삭제 모드 ON ─────
    if (isDeleteMode) {
      // ① 선 색 빨갛게(한 번만)
      if (!line.originalColor) {
        line.originalColor = line.instance.color;
        line.instance.setOptions({ color: '#e54b4b' });
      }

      // ② ❌ 핀 생성
      if (!line.deleteBtn) {
        const btn = document.createElement('div');
        btn.className = 'line-delete-btn';
        btn.textContent = '×';
        btn.onclick = (e) => {
          e.stopPropagation();
          deleteLine(line.id);
        };
        document.body.appendChild(btn);
        line.deleteBtn = btn;
        positionDeleteBtn(line);
      }
    }
    // ───── 삭제 모드 OFF ─────
    else {
      if (line.originalColor) {
        line.instance.setOptions({ color: line.originalColor });
        line.originalColor = null;
      }
      if (line.deleteBtn) {
        line.deleteBtn.remove();
        line.deleteBtn = null;
      }
    }
  });
}

/* 선·블록 이동 시 ❌ 위치 갱신 */
function refreshDeletePins() {
  if (!isDeleteMode) return;
  lines.forEach(positionDeleteBtn);
}

/* deleteLine → 핀/선 동시 제거 */
function deleteLine(id) {
  const idx = lines.findIndex((l) => l.id === id);
  if (idx === -1) return;

  const line = lines[idx];
  line.instance?.remove();
  line.deleteBtn?.remove();
  lines.splice(idx, 1);
}

/* 기존 updateLines() 호출 뒤에 핀도 이동하도록 덮어쓰기 */
const _origUpdateLines = updateLines;
updateLines = function () {
  _origUpdateLines();
  refreshDeletePins();
};


    /* =========================================================
     * 10. Interact.js (드래그 + 리사이즈)
     * ========================================================= */
    interact('.block')
        .draggable({
            allowFrom: '.block-label',
            listeners: {
                start(ev) {
                    const t = ev.currentTarget;
                    const st = window.getComputedStyle(t);
                    t.setAttribute('data-x', parseFloat(st.left) || 0);
                    t.setAttribute('data-y', parseFloat(st.top) || 0);
                },
                move(ev) {
                    const t = ev.currentTarget;
                    const x = (parseFloat(t.getAttribute('data-x')) || 0) + ev.dx;
                    const y = (parseFloat(t.getAttribute('data-y')) || 0) + ev.dy;
                    t.style.left = `${x}px`;
                    t.style.top = `${y}px`;
                    t.setAttribute('data-x', x);
                    t.setAttribute('data-y', y);
                    if (blocks[t.id]) {
                        blocks[t.id].x = x;
                        blocks[t.id].y = y;
                    }
                    updateLines();
                },
            },
            modifiers: [interact.modifiers.restrictRect({ restriction: '#canvas-container' })],
        })
        .resizable({
            edges: { right: '.resize-handle', bottom: '.resize-handle' },
            listeners: {
                move(ev) {
                    const t = ev.target;
                    const blk = blocks[t.id];
                    if (!blk) return;
                    t.style.width = `${ev.rect.width}px`;
                    t.style.height = `${ev.rect.height}px`;
                    blk.width = ev.rect.width;
                    blk.height = ev.rect.height;
                    updateLines();
                },
            },
            modifiers: [interact.modifiers.restrictSize({ min: { width: 120, height: 80 } })],
        });

    /* =========================================================
     * 11. 컨텍스트 메뉴(복사, 붙여넣기, 색상, 폰트 등)
     * ========================================================= */
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const blkEl = e.target.closest('.block');
        
        contextMenu.style.display = 'none';
        canvasContextMenu.style.display = 'none';

        if (blkEl) {
            contextTarget = { type: 'block', id: blkEl.id };
            contextMenu.style.display = 'block';
            contextMenu.style.left = `${e.clientX}px`;
            contextMenu.style.top = `${e.clientY}px`;
        } else if (e.target === canvasContainer) {
            lastContextMenuPos = { x: e.clientX, y: e.clientY };
            const pasteButton = document.getElementById('paste-block');
            pasteButton.disabled = !clipboard;

            canvasContextMenu.style.display = 'block';
            canvasContextMenu.style.left = `${e.clientX}px`;
            canvasContextMenu.style.top = `${e.clientY}px`;
        }
    });

    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) contextMenu.style.display = 'none';
        if (!canvasContextMenu.contains(e.target)) canvasContextMenu.style.display = 'none';
    });

    contextMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        const color = e.target.dataset.color;
        if (color && contextTarget?.type === 'block') {
            const blk = blocks[contextTarget.id];
            blk.el.style.backgroundColor = color;
            blk.color = color;
        }
    });
    
    document.getElementById('copy-block').onclick = () => {
        if (contextTarget?.type === 'block') {
            const sourceBlock = blocks[contextTarget.id];
            if (sourceBlock) {
                clipboard = {
                    type: sourceBlock.type,
                    width: sourceBlock.width,
                    label: sourceBlock.label,
                    color: sourceBlock.color,
                    fontSize: sourceBlock.fontSize,
                    branches: sourceBlock.branches.map(branch => ({ text: branch.text }))
                };
            }
        }
        contextMenu.style.display = 'none';
    };

    // [NEW] 컨텍스트 메뉴에서 블록 삭제
    document.getElementById('delete-block-context').onclick = () => {
        if (contextTarget?.type === 'block') {
            const blockToDelete = blocks[contextTarget.id];
            if (blockToDelete && confirm(`'${blockToDelete.label}' 블록을 정말로 삭제하시겠습니까?`)) {
                deleteBlock(contextTarget.id, true); // 강제 삭제 옵션으로 호출
            }
        }
        contextMenu.style.display = 'none';
    };

    document.getElementById('paste-block').onclick = () => {
        if (!clipboard) return;

        const canvasRect = canvasContainer.getBoundingClientRect();
        const x = lastContextMenuPos.x - canvasRect.left + canvasContainer.scrollLeft;
        const y = lastContextMenuPos.y - canvasRect.top + canvasContainer.scrollTop;

        blockCounter++;
        const newId = `block-${blockCounter}`;
        
        const dataForCreation = { ...clipboard };
        if (dataForCreation.type === 'branch' && dataForCreation.branches) {
            dataForCreation.branches = dataForCreation.branches.map((branch, index) => ({
                id: `branch-${Date.now()}-${index}`,
                text: branch.text
            }));
        }

        createBlock(newId, x, y, dataForCreation.width, null, dataForCreation.type, dataForCreation);
        canvasContextMenu.style.display = 'none';
    };

    const changeFontSize = (block, dir) => {
        const lbl = block.el.querySelector('.block-label');
        if (!lbl) return;
        const cur = parseFloat(window.getComputedStyle(lbl).fontSize);
        const next = dir === 'increase' ? cur + 1 : cur - 1;
        if (next < 8 || next > 40) return;
        lbl.style.fontSize = `${next}px`;
        block.fontSize = `${next}px`;
        autoResizeBlock(block.el.id);
    };
    document.getElementById('increase-font').onclick = () => {
        if (contextTarget?.type === 'block') changeFontSize(blocks[contextTarget.id], 'increase');
    };
    document.getElementById('decrease-font').onclick = () => {
        if (contextTarget?.type === 'block') changeFontSize(blocks[contextTarget.id], 'decrease');
    };

    /* =========================================================
     * 12. 툴바 버튼 연결
     * ========================================================= */
    document.getElementById('add-block').onclick = () => addNewBlock('default');
    document.getElementById('add-branch-block').onclick = () => addNewBlock('branch');
    document.getElementById('delete-mode-toggle').onclick = () => {
        isDeleteMode = !isDeleteMode;
        canvasContainer.classList.toggle('delete-mode-active', isDeleteMode);
        document.getElementById('delete-mode-toggle').classList.toggle('active', isDeleteMode);
        updateLineDeleteListeners();
    };

    function saveState() {
        const bl = Object.entries(blocks).map(([id, b]) => ({
            id, x: b.x, y: b.y, width: b.width, height: b.height,
            type: b.type, label: b.label, branches: b.branches,
            color: b.color, fontSize: b.fontSize,
        }));
        const ln = lines.map((l) => ({
            sourceBlock: l.sourceBlock, sourceHandle: l.sourceHandle,
            targetBlock: l.targetBlock, targetHandle: l.targetHandle,
            color: l.color,
        }));
        localStorage.setItem('diagramState', JSON.stringify({ blocks: bl, lines: ln, blockCounter }));
        alert('작업 내용이 저장되었습니다.');
    }

    function loadState() {
        const raw = localStorage.getItem('diagramState');
        if (!raw) return;
        const state = JSON.parse(raw);
        clearCanvas();
        blockCounter = state.blockCounter || 0;
        state.blocks.forEach((b) => createBlock(b.id, b.x, b.y, b.width, b.height, b.type, b));
        state.lines.forEach((l) => {
            const src = document.querySelector(`#${l.sourceBlock} .handle[data-handle-id="${l.sourceHandle}"]`);
            const tgt = document.querySelector(`#${l.targetBlock} .handle[data-handle-id="${l.targetHandle}"]`);
            if (src && tgt) {
                const id = `line-${Date.now()}`;
                const leader = new LeaderLine(src, tgt, {
                    color: l.color || 'rgba(255,255,255,0.7)', size: 3,
                    path: 'fluid', endPlug: 'arrow1',
                });
                lines.push({ ...l, id, instance: leader });
            }
        });
        setTimeout(updateLineDeleteListeners, 0);
    }

    function clearCanvas() {
        lines.forEach((l) => l.instance?.remove());
        lines = [];
        Object.values(blocks).forEach((b) => b.el.remove());
        blocks = {};
        blockCounter = 0;
    }

    document.getElementById('save-diagram').onclick = saveState;
    document.getElementById('load-diagram').onclick = () => {
        if (confirm('정말로 불러오시겠습니까? 현재 작업 내용은 저장되지 않고 사라집니다.')) loadState();
    };
    document.getElementById('clear-diagram').onclick = () => {
        if (confirm('정말로 모든 작업을 지우시겠습니까?')) clearCanvas();
    };

function generatePrompt() {
        const out = document.getElementById('prompt-output');
        const modal = document.getElementById('prompt-modal');

        // --- YAML 생성을 위한 새로운 로직 ---

        // 1. 모든 블록과 연결선으로부터 타겟이 되는 블록 ID 집합 생성
        const targetBlockIds = new Set(lines.map(line => line.targetBlock));
        
        // 2. 플로우 시작점 찾기 (다른 블록의 타겟이 아닌 블록)
        const startNodes = Object.values(blocks).filter(block => !targetBlockIds.has(block.el.id));
        
        // 3. 연결이 전혀 없는 블록 찾기 (전역 지시사항으로 간주)
        const sourceBlockIds = new Set(lines.map(line => line.sourceBlock));
        const unconnectedNodes = Object.values(blocks).filter(block => 
            !targetBlockIds.has(block.el.id) && !sourceBlockIds.has(block.el.id)
        );

        // 제목(title)으로 사용할 블록 찾기 (예: 가장 위에 있는 미연결 블록)
        const titleNode = unconnectedNodes.sort((a, b) => a.y - b.y)[0];
        const globalInstructions = unconnectedNodes.filter(n => n !== titleNode);

        // [MODIFIED] 프롬프트 최상단에 지시 문구 추가
        let yamlOutput = "아래 흐름에 따라 코딩을 하여 완성된 프로그램을 제시할 것\n\n---\n\n";
        
        // YAML의 기본 구조 생성
        if (titleNode) {
            yamlOutput += `title: ${titleNode.label}\n`;
        }

        if (globalInstructions.length > 0) {
            yamlOutput += "global_instructions:\n";
            globalInstructions.forEach(node => {
                yamlOutput += `  - ${node.label}\n`;
            });
        }

        yamlOutput += "flow:\n";

        // 4. 플로우 순회 및 YAML 변환 함수
        const processedBlocks = new Set();
        let stepCounter = 1;

        function buildFlowYaml(blockId, indent = "  ") {
            if (processedBlocks.has(blockId)) return;
            
            const block = blocks[blockId];
            if (!block) return;
            
            processedBlocks.add(blockId);
            const currentStep = stepCounter++;

            if (block.type !== 'branch') {
                yamlOutput += `${indent}- step: ${currentStep}\n`;
                yamlOutput += `${indent}  description: ${block.label}\n`;
                
                const nextLine = lines.find(line => line.sourceBlock === blockId);
                if (nextLine) {
                    buildFlowYaml(nextLine.targetBlock, indent);
                }
            } else {
                yamlOutput += `${indent}- step: ${currentStep}\n`;
                yamlOutput += `${indent}  type: branch\n`;
                yamlOutput += `${indent}  description: ${block.label}\n`;
                yamlOutput += `${indent}  conditions:\n`;

                block.branches.forEach(branch => {
                    yamlOutput += `${indent}    - condition: ${branch.text}\n`;
                    
                    const branchLine = lines.find(line => line.sourceHandle.startsWith(branch.id));
                    if (branchLine) {
                        yamlOutput += `${indent}      next_steps:\n`;
                        buildBranchSteps(branchLine.targetBlock, `${indent}        `, 1);
                    }
                });
            }
        }
        
        function buildBranchSteps(blockId, indent, subStep) {
             const block = blocks[blockId];
             if (!block) return;

             yamlOutput += `${indent}- step: ${subStep}\n`;
             yamlOutput += `${indent}  description: ${block.label}\n`;
             
             const nextLine = lines.find(line => line.sourceBlock === blockId);
             if (nextLine) {
                 buildBranchSteps(nextLine.targetBlock, indent, subStep + 1);
             }
        }

        // 5. 시작 노드부터 순회 시작
        const flowStartNodes = startNodes.filter(node => !unconnectedNodes.includes(node));
        flowStartNodes.forEach(startNode => {
             buildFlowYaml(startNode.el.id);
        });
        
        out.value = yamlOutput;
        modal.classList.remove('hidden');
    }

    // [NEW] 복사하기 및 파일 저장 버튼 이벤트 리스너
    document.getElementById('copy-prompt-btn').onclick = () => {
        const promptText = document.getElementById('prompt-output').value;
        navigator.clipboard.writeText(promptText).then(() => {
            alert('프롬프트가 클립보드에 복사되었습니다.');
        }).catch(err => {
            console.error('복사 실패:', err);
            alert('복사에 실패했습니다.');
        });
    };

    document.getElementById('save-prompt-btn').onclick = () => {
        const promptText = document.getElementById('prompt-output').value;
        const blob = new Blob([promptText], { type: 'text/yaml;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'prompt.yaml';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // 기존 generate-prompt 버튼 연결부는 그대로 유지
    document.getElementById('generate-prompt').onclick = generatePrompt;
    document.getElementById('close-modal').onclick = () =>
        document.getElementById('prompt-modal').classList.add('hidden');

//... (이전 코드 생략) ...

    /* =========================================================
     * 13. 처음 로드시 상태 복구
     * ========================================================= */
    loadState();
});