window.__ModuleLoader__.load({
	id: "dsh-vim-desktop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// ===================================================================
		// dsh-vim-desktop — 客户端半边（G1：hjkl 控制三栏）
		//
		// 一次按键的生命周期：window 捕获阶段 keydown → 这里判断要不要接管
		// → 接管了就 preventDefault + stopPropagation，没接管就原样放行。
		// 只有三件事算「接管」：无修饰键、焦点不在可编辑元素里、键在键表里。
		// ===================================================================

		const REGIONS = ["sidebar", "main", "rightbar"];
		const REGION_LABEL = { sidebar: "工作区", main: "会话", rightbar: "面板" };
		/** 连按两键（gg / gi）的最大间隔。 */
		const PENDING_MS = 700;

		const state = {
			region: "main",
			/** normal / insert。常态是 normal，只有 i / gi 或鼠标点进输入框才进 insert。 */
			mode: "normal",
			index: { sidebar: 0, main: 0, rightbar: 0, workspace: 0 },
			pending: "",
			timer: 0,
			/** 短暂提示，覆盖状态条正文。 */
			notice: "",
			noticeTimer: 0,
		};

		let bar = null;
		let styleEl = null;

		// ---------------------------------------------------------------
		// DOM 探测
		// ---------------------------------------------------------------

		/** 焦点在输入框 / contenteditable 里（Lexical 的编辑器也是 contenteditable）。 */
		function isEditable(el) {
			if (!el || el.nodeType !== 1) return false;
			const tag = el.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA") return true;
			return el.isContentEditable === true;
		}

		/** 元素是否真的占着位置（收起/隐藏的栏内容会被算作不可见）。 */
		function isVisible(el) {
			const rect = el.getBoundingClientRect();
			if (rect.width <= 0 || rect.height <= 0) return false;
			const style = getComputedStyle(el);
			return style.visibility !== "hidden" && style.display !== "none";
		}

		/**
		 * 三栏所在的那层 grid。左栏开合属性挂在它身上。
		 *
		 * 优先用 shell.overlay 那个槽的容器——它每一页都在，父节点就是框架；
		 * 会话页才有的标记只作兜底。
		 */
		function frameRoot() {
			const overlay = document.querySelector("[data-shell-overlay]");
			if (overlay && overlay.parentElement) return overlay.parentElement;

			const scroll = document.querySelector("[data-conversation-scroll]");
			if (!scroll) return null;
			let el = scroll;
			while (el.parentElement) {
				const parent = el.parentElement;
				if (getComputedStyle(parent).display === "grid" && parent.children.length >= 2) return parent;
				el = parent;
			}
			return null;
		}

		/**
		 * 中栏的滚动容器。
		 *
		 * 会话页有 data-conversation-scroll 标记；插件市场之类的全局面板没有，
		 * 那些页面上 j/k 原本是死的，现在退回去找中栏里第一个能滚的容器。
		 */
		function mainScroller() {
			const marked = document.querySelector("[data-conversation-scroll]");
			if (marked) {
				let el = marked;
				for (let depth = 0; el && depth < 4; depth += 1) {
					if (el.scrollHeight > el.clientHeight + 4) return el;
					el = el.parentElement;
				}
				return marked;
			}
			return scrollableIn(frameRoot());
		}

		/** 广度优先找第一个 overflow-y 可滚的容器，最多看 400 个节点。 */
		function scrollableIn(root) {
			if (!root) return null;
			const queue = [...root.children];
			let seen = 0;
			while (queue.length && seen < 400) {
				const el = queue.shift();
				seen += 1;
				const style = getComputedStyle(el);
				if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 4) {
					return el;
				}
				queue.push(...el.children);
			}
			return null;
		}

		/** 左栏里能走的会话行 / 右栏里能走的 tab。 */
		function regionItems(region) {
			if (region === "sidebar") {
				return [...document.querySelectorAll('[role="treeitem"][data-row-key^="session:"]')].filter(isVisible);
			}
			if (region === "rightbar") {
				return [...document.querySelectorAll("[data-sidebar-right-tab]")].filter(isVisible);
			}
			return [];
		}

		/** 左栏的工作区行。 */
		function workspaceRows() {
			return [...document.querySelectorAll('[role="treeitem"][data-row-key^="workspace:"]')].filter(isVisible);
		}

		/**
		 * h / l 在左栏里换工作区：把光标挪过去，收起状态就展开，不主动折叠。
		 * 区域间的切换因此只剩 g s（和 Esc 回中栏）。
		 */
		function moveWorkspace(step) {
			const rows = workspaceRows();
			if (!rows.length) {
				notice("没有工作区行");
				return;
			}
			const next = Math.max(0, Math.min(rows.length - 1, state.index.workspace + step));
			if (next === state.index.workspace) {
				notice(step > 0 ? "已经是最后一个工作区" : "已经是第一个工作区");
				return;
			}
			state.index.workspace = next;
			const row = rows[next];
			document.querySelectorAll("[data-dvim-cursor]").forEach((el) => el.removeAttribute("data-dvim-cursor"));
			row.setAttribute("data-dvim-cursor", "");
			if (row.getAttribute("aria-expanded") === "false") row.click();
			row.scrollIntoView({ block: "nearest", inline: "nearest" });
			renderBar();
		}

		/** 栏是不是开着的。收起态从 grid 根上的 data-* 读，读不到就退回内容探测。 */
		function regionOpen(region) {
			const frame = frameRoot();
			if (region === "sidebar") {
				if (frame) return !frame.hasAttribute("data-sidebar-collapsed");
				return !!document.querySelector('[role="tree"]');
			}
			if (region === "rightbar") {
				if (frame) return !frame.hasAttribute("data-rightbar-collapsed");
				return !!document.querySelector("[data-sidebar-right-panel]");
			}
			return true;
		}

		/** 输入框（Lexical 的 contenteditable 根）。 */
		function composer() {
			return (
				document.querySelector('[data-composer-seat] [contenteditable="true"]') ||
				document.querySelector('[contenteditable="true"]')
			);
		}

		// ---------------------------------------------------------------
		// 状态条
		// ---------------------------------------------------------------

		function renderBar() {
			if (!bar) return;
			positionBar();
			if (state.notice) {
				bar.textContent = state.notice;
				return;
			}
			if (hintState.active) {
				bar.textContent = `HINT ${hintState.action}  ${hintState.typed}`;
				return;
			}
			const pos = state.region === "main" ? `${scrollPercent()}%` : indexLabel(state.region);
			const mode = state.mode === "insert" ? "INSERT" : "NORMAL";
			bar.textContent = `${mode}  ${REGION_LABEL[state.region]} ${pos}${state.pending ? `  ${state.pending}` : ""}`;
		}

		/** 状态条贴在会话栏的左下角，压在侧栏上不算。 */
		function positionBar() {
			if (!bar) return;
			const frame = frameRoot();
			const sidebar = frame && frame.children[0];
			if (!sidebar) return;
			const rect = sidebar.getBoundingClientRect();
			bar.style.left = `${Math.max(8, rect.right + 8)}px`;
		}

		/**
		 * 模式是显式的，不跟着焦点跑。
		 *
		 * 以前用「焦点在不在可编辑元素里」推模式，宿主一换页面就聚焦输入框，
		 * 模式自动跳到 INSERT，j/k 变成打字。现在只有两件事改模式：
		 * `i` / `gi`，以及鼠标真的点进了可编辑元素。
		 */
		function setMode(mode) {
			if (state.mode === mode) return;
			state.mode = mode;
			renderBar();
		}

		/** 左栏 / 右栏的「第几条 / 共几条」。 */
		function indexLabel(region) {
			const total = regionItems(region).length;
			return total > 0 ? `${state.index[region] + 1}/${total}` : "-/-";
		}

		/** 中栏滚到整个对话的百分之几。 */
		function scrollPercent() {
			const scroller = mainScroller();
			if (!scroller) return "-";
			const max = scroller.scrollHeight - scroller.clientHeight;
			if (max <= 0) return "100";
			return String(Math.round((scroller.scrollTop / max) * 100));
		}

		/** 状态条上闪一句话。 */
		function notice(text) {
			state.notice = text;
			clearTimeout(state.noticeTimer);
			state.noticeTimer = setTimeout(() => {
				state.notice = "";
				renderBar();
			}, 1200);
			renderBar();
		}

		// ---------------------------------------------------------------
		// 光标与移动
		// ---------------------------------------------------------------

		/** 把某栏的光标对到视线附近的那一条（进栏时用，避免永远从第 0 条开始）。 */
		function syncIndexToView(region) {
			const list = regionItems(region);
			if (!list.length) {
				state.index[region] = 0;
				return;
			}
			const probe = window.innerHeight / 2;
			let best = 0;
			let bestDistance = Infinity;
			list.forEach((el, i) => {
				const rect = el.getBoundingClientRect();
				const distance = Math.abs(rect.top - probe);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = i;
				}
			});
			state.index[region] = best;
		}

		/** 一行有多高：先问正文段落，问不到就按字号估。 */
		function lineHeight() {
			const scroller = mainScroller();
			const probe = scroller && scroller.querySelector("p, li, [data-chat-turn]");
			const style = getComputedStyle(probe || scroller || document.body);
			const measured = parseFloat(style.lineHeight);
			if (Number.isFinite(measured) && measured > 0) return measured;
			const size = parseFloat(style.fontSize);
			return Math.round((Number.isFinite(size) && size > 0 ? size : 16) * 1.6);
		}

		/**
		 * 中栏按行滚。
		 *
		 * 早先这里按「轮」对齐：一轮常常就是一屏，按一下 j 等于半个 Ctrl-D。
		 * 那是翻页，不是移动。现在一按一行，按住会自己重复。
		 */
		function scrollLines(step) {
			const scroller = mainScroller();
			if (!scroller) return;
			scroller.scrollTop += lineHeight() * step;
			renderBar();
		}

		/** 重画：清掉旧光标 → 夹紧索引 → 标上新光标 → 滚过去 → 刷新状态条。 */
		function paint() {
			document.querySelectorAll("[data-dvim-cursor]").forEach((el) => el.removeAttribute("data-dvim-cursor"));
			if (state.region !== "main") {
				const list = regionItems(state.region);
				if (list.length) {
					const index = Math.max(0, Math.min(list.length - 1, state.index[state.region]));
					state.index[state.region] = index;
					const current = list[index];
					current.setAttribute("data-dvim-cursor", "");
					current.scrollIntoView({ block: "nearest", inline: "nearest" });
				} else {
					state.index[state.region] = 0;
				}
			}
			renderBar();
		}

		/** h / l：往左右挪一栏，跳过没开的那一栏，到边界就停。 */
		function moveRegion(step) {
			let i = REGIONS.indexOf(state.region) + step;
			while (i >= 0 && i < REGIONS.length) {
				const next = REGIONS[i];
				if (regionOpen(next)) {
					state.region = next;
					syncIndexToView(next);
					paint();
					return;
				}
				i += step;
			}
			notice(step < 0 ? "左栏收起了" : "右栏没打开");
		}

		/** g h / g s：直接跳到某一栏，不看当前位置。 */
		function jumpRegion(region) {
			if (!regionOpen(region)) {
				notice(region === "sidebar" ? "左栏收起了" : "右栏没打开");
				return;
			}
			state.region = region;
			if (region !== "main") syncIndexToView(region);
			paint();
		}

		/** g s：在工作区（左栏）与会话（中栏）之间来回切。 */
		function toggleRegion() {
			if (state.region === "sidebar") jumpRegion("main");
			else jumpRegion("sidebar");
		}

		/** j / k：中栏滚一行，其余栏走一条。 */
		function moveItem(step) {
			if (state.region === "main") {
				scrollLines(step);
				return;
			}
			const list = regionItems(state.region);
			if (!list.length) return;
			const next = state.index[state.region] + step;
			if (next < 0 || next >= list.length) {
				notice(step > 0 ? "到底了" : "到头了");
				return;
			}
			state.index[state.region] = next;
			paint();
		}

		/** Enter：点当前条目（宿主自己的行就是按 click 处理的）。中栏没有「条目」可点。 */
		function enterItem() {
			if (state.region === "main") {
				notice("中栏没有可点的条目");
				return;
			}
			const list = regionItems(state.region);
			const current = list[state.index[state.region]];
			if (!current) return;
			// 工作区行带 aria-expanded，是展开/折叠；会话行没有，是打开。
			const expandable = current.hasAttribute("aria-expanded") || current.querySelector("[aria-expanded]") !== null;
			current.click();
			if (state.region === "sidebar" && !expandable) {
				state.region = "main";
				paint();
			}
		}

		/** 所有会话行。工作区行是 data-row-key="workspace:…"，会话行是 "session:…"。 */
		function sessionRows() {
			return [...document.querySelectorAll('[role="treeitem"][data-row-key^="session:"]')].filter(isVisible);
		}

		/** H / L / gs / gS：切上一条 / 下一条会话。 */
		function switchSession(step) {
			const rows = sessionRows();
			if (!rows.length) {
				notice("没有会话");
				return;
			}
			const current = rows.findIndex((row) => row.getAttribute("aria-selected") === "true");
			// 没选中任何会话时（空白新会话），从边界外开始算，第一次就落到第一条。
			const base = current >= 0 ? current : -step;
			const next = Math.max(0, Math.min(rows.length - 1, base + step));
			if (next === base) {
				notice(step > 0 ? "已经是最后一个会话" : "已经是第一个会话");
				return;
			}
			rows[next].click();
			state.region = "main";
			paint();
			notice(`会话 ${next + 1}/${rows.length}`);
		}

		/** 中栏顶 / 底。 */
		function goTop() {
			const scroller = mainScroller();
			if (!scroller) return;
			scroller.scrollTop = 0;
			state.region = "main";
			paint();
		}

		function goBottom() {
			const scroller = mainScroller();
			if (!scroller) return;
			scroller.scrollTop = scroller.scrollHeight;
			state.region = "main";
			paint();
		}

		/** d / u：中栏半页。 */
		function halfPage(step) {
			const scroller = mainScroller();
			if (!scroller) return;
			scroller.scrollTop += (scroller.clientHeight / 2) * step;
			state.region = "main";
			paint();
		}

		/** gi / i：进输入框。 */
		function focusComposer() {
			const el = composer();
			if (!el) {
				notice("找不到输入框");
				return;
			}
			state.region = "main";
			el.focus();
			setMode("insert");
			paint();
		}

		// ---------------------------------------------------------------
		// 按键
		// ---------------------------------------------------------------

		function consume(event) {
			event.preventDefault();
			event.stopPropagation();
		}

		function clearPending() {
			state.pending = "";
			clearTimeout(state.timer);
			state.timer = 0;
		}

		function setPending(key) {
			state.pending = key;
			clearTimeout(state.timer);
			state.timer = setTimeout(() => {
				state.pending = "";
				renderBar();
			}, PENDING_MS);
			renderBar();
		}

		function onKeyDown(event) {
			if (event.defaultPrevented) return;
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			if (event.isComposing) return;

			// 浮层开着：只管导航键，其余交给它的输入框。
			if (palette.open) {
				paletteKey(event);
				return;
			}

			// hint 标签挂着：只认字母。
			if (hintState.active) {
				hintKey(event);
				return;
			}

			// INSERT：除了 Esc，一律让给宿主。
			if (state.mode === "insert") {
				if (event.key !== "Escape") return;
				consume(event);
				clearPending();
				if (isEditable(document.activeElement)) document.activeElement.blur();
				setMode("normal");
				state.region = "main";
				paint();
				return;
			}

			// NORMAL，在左栏 / 右栏按 Esc：收回中栏。
			if (event.key === "Escape" && state.region !== "main") {
				consume(event);
				clearPending();
				state.region = "main";
				paint();
				return;
			}

			const key = event.key;

			// 第二键：g 之后等 g / i。
			if (state.pending === "g") {
				clearPending();
				if (key === "g") {
					consume(event);
					goTop();
					return;
				}
				if (key === "i") {
					consume(event);
					focusComposer();
					return;
				}
				if (key === "s") {
					consume(event);
					toggleRegion();
					return;
				}
			}

			switch (key) {
				case "h":
					consume(event);
					if (state.region === "sidebar") moveWorkspace(-1);
					else moveRegion(-1);
					return;
				case "l":
					consume(event);
					if (state.region === "sidebar") moveWorkspace(1);
					else moveRegion(1);
					return;
				case "j":
					consume(event);
					moveItem(1);
					return;
				case "k":
					consume(event);
					moveItem(-1);
					return;
				case "g":
					consume(event);
					setPending("g");
					return;
				case "G":
					consume(event);
					goBottom();
					return;
				case "H":
					consume(event);
					switchSession(-1);
					return;
				case "L":
					consume(event);
					switchSession(1);
					return;
				case "d":
					consume(event);
					halfPage(1);
					return;
				case "f":
					consume(event);
					startHints("click");
					return;
				case ";":
					consume(event);
					startHints("copy");
					return;
				case "u":
					consume(event);
					halfPage(-1);
					return;
				case "i":
					consume(event);
					focusComposer();
					return;
				case ":":
					consume(event);
					openPalette();
					return;
				case "a":
					consume(event);
					newSession();
					return;
				case "F":
					consume(event);
					pickFile();
					return;
				case "Enter":
					consume(event);
					enterItem();
					return;
				default:
					// NORMAL 里焦点却落在输入框上（宿主自己聚焦的）：
					// 把可打印键吞掉，否则 j/k 就变成打字了。
					if (isEditable(document.activeElement)) consume(event);
					return;
			}
		}

		/** a：新会话。 */
		function newSession() {
			const workspace = runtime && typeof runtime.get === "function" ? runtime.get("uiWorkspace") : null;
			if (workspace && typeof workspace.startSession === "function") {
				workspace.startSession();
				return;
			}
			notice("找不到新会话入口");
		}

		/**
		 * F：跳过手打 /file，直接开文件选择。
		 *
		 * 宿主没把 pickFiles 暴露出来，只能点「指令」按钮再点菜单里的「文件」。
		 * 菜单是 portal 渲染的，要等一帧才找得到。
		 */
		function pickFile() {
			const trigger = [...document.querySelectorAll("button")].find((el) => {
				const label = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
				return /^(指令|命令|commands?)$/i.test(label);
			});
			if (!trigger) {
				notice("找不到「指令」按钮");
				return;
			}
			trigger.click();
			setTimeout(() => {
				const item = [...document.querySelectorAll('[role="menuitem"], [role="option"], li, button')].find((el) => {
					const text = (el.textContent || "").trim();
					return /^(文件|File)$/i.test(text);
				});
				if (item) item.click();
				else notice("菜单里没有「文件」");
			}, 80);
		}

		// ---------------------------------------------------------------
		// hint（f 点控件 / ; 复制）
		// ---------------------------------------------------------------

		/** 标签字母表。跳过 ; ，免得和自己打架。 */
		const HINT_ALPHABET = "asdfghjklqwertyuiopzxcvbnm";

		/** 可点的东西：链接、按钮、树行、tab、输入框，以及主动声明 tabindex 的元素。 */
		const HINT_SELECTOR = [
			"a[href]",
			"button",
			'[role="button"]',
			'[role="tab"]',
			'[role="treeitem"]',
			'[role="menuitem"]',
			'[role="option"]',
			'[role="switch"]',
			"input",
			"textarea",
			"summary",
			"[contenteditable='true']",
			"[tabindex]:not([tabindex='-1'])",
		].join(",");

		const hintState = { active: false, action: "click", typed: "", items: [], layer: null };

		function hintables() {
			return [...document.querySelectorAll(HINT_SELECTOR)]
				.filter((el) => !el.closest("[data-dvim-hint]"))
				.filter(isVisible)
				.filter((el) => {
					const rect = el.getBoundingClientRect();
					return rect.bottom > 0 && rect.top < window.innerHeight;
				});
		}

		/** 够用就单字母，不够就两字母。 */
		function hintLabels(count) {
			if (count <= HINT_ALPHABET.length) return [...HINT_ALPHABET].slice(0, count);
			const labels = [];
			for (const first of HINT_ALPHABET) {
				for (const second of HINT_ALPHABET) {
					labels.push(first + second);
					if (labels.length >= count) return labels;
				}
			}
			return labels;
		}

		function startHints(action) {
			cancelHints();
			const els = hintables();
			if (!els.length) {
				notice("这里没有可点的东西");
				return;
			}

			const labels = hintLabels(els.length);
			const layer = document.createElement("div");
			layer.setAttribute("data-dvim-hint", "");

			els.forEach((el, i) => {
				const rect = el.getBoundingClientRect();
				const tag = document.createElement("span");
				tag.setAttribute("data-dvim-hint-label", "");
				tag.textContent = labels[i];
				tag.style.left = `${Math.max(2, rect.left)}px`;
				tag.style.top = `${Math.max(2, rect.top)}px`;
				layer.appendChild(tag);
			});

			document.body.appendChild(layer);
			hintState.active = true;
			hintState.action = action;
			hintState.typed = "";
			hintState.layer = layer;
			hintState.items = els.map((el, i) => ({ el, label: labels[i] }));
			renderBar();
		}

		function cancelHints() {
			if (hintState.layer) hintState.layer.remove();
			hintState.active = false;
			hintState.layer = null;
			hintState.items = [];
			hintState.typed = "";
			renderBar();
		}

		function copyText(text) {
			const value = String(text || "").trim();
			if (!value) {
				notice("没东西可复制");
				return;
			}
			if (!navigator.clipboard) {
				notice("剪贴板不可用");
				return;
			}
			navigator.clipboard.writeText(value).then(
				() => notice("已复制"),
				() => notice("复制失败"),
			);
		}

		function runHint(label) {
			const item = hintState.items.find((row) => row.label === label);
			if (!item) return;
			const el = item.el;
			const action = hintState.action;
			cancelHints();

			if (action === "copy") {
				copyText(el.href || el.textContent);
				return;
			}
			el.click();
		}

		/** hint 模式下吞掉按键：Esc 取消，字母累积匹配。 */
		function hintKey(event) {
			if (event.key === "Escape") {
				consume(event);
				cancelHints();
				return;
			}
			if (event.key.length !== 1) {
				consume(event);
				return;
			}
			consume(event);
			const typed = `${hintState.typed}${event.key.toLowerCase()}`;
			if (hintState.items.some((row) => row.label === typed)) {
				runHint(typed);
				return;
			}
			hintState.typed = hintState.items.some((row) => row.label.startsWith(typed)) ? typed : "";
			renderBar();
		}

		// ---------------------------------------------------------------
		// 命令行浮层
		// ---------------------------------------------------------------

		/** 本插件自己的命令。宿主命令在浮层打开后异步补进来。 */
		const LOCAL_COMMANDS = [
			{ name: "help", desc: "键位速查" },
			{ name: "reload", desc: "刷新页面（不重载插件）" },
			{ name: "q", desc: "关闭窗口" },
		];

		const KEYMAP = [
			["h / l", "工作区里换工作区；别处换栏"],
			["j / k", "会话里滚一行；工作区走会话、面板走 tab"],
			["d / u", "会话半页"],
			["g g / G", "会话顶 / 底"],
			["H / L", "上一条 / 下一条会话"],
			["g s", "工作区 ↔ 会话"],
			["i / g i", "进输入框"],
			["a", "新会话"],
			["F", "选文件（跳过 /file）"],
			["f / ;", "点控件 / 复制"],
			["Enter", "打开当前条目"],
			["Esc", "退回"],
			[":", "命令行"],
		];

		const palette = {
			el: null,
			input: null,
			list: null,
			items: [],
			index: 0,
			open: false,
			mode: "commands",
		};

		/** apply 时塞进来的 ctx。 */
		let runtime = null;

		function ensurePalette() {
			if (palette.el) return;

			const wrap = document.createElement("div");
			wrap.setAttribute("data-dvim-palette", "");
			wrap.hidden = true;

			const input = document.createElement("input");
			input.setAttribute("data-dvim-palette-input", "");
			input.type = "text";
			input.placeholder = "命令";
			input.spellcheck = false;

			const list = document.createElement("div");
			list.setAttribute("data-dvim-palette-list", "");

			wrap.append(input, list);
			document.body.appendChild(wrap);

			input.addEventListener("input", () => {
				palette.index = 0;
				renderPalette();
			});

			palette.el = wrap;
			palette.input = input;
			palette.list = list;
		}

		/** 子序列匹配：`rl` 也能命中 `reload`。 */
		function matches(needle, haystack) {
			if (!needle) return true;
			const text = haystack.toLowerCase();
			let i = 0;
			for (const ch of text) {
				if (ch === needle[i]) i += 1;
				if (i === needle.length) return true;
			}
			return false;
		}

		function renderPalette() {
			if (!palette.el) return;
			palette.list.replaceChildren();

			if (palette.mode === "help") {
				for (const [keys, action] of KEYMAP) {
					const row = document.createElement("div");
					row.setAttribute("data-dvim-palette-item", "");
					const key = document.createElement("span");
					key.textContent = keys;
					const text = document.createElement("span");
					text.textContent = action;
					row.append(key, text);
					palette.list.appendChild(row);
				}
				return;
			}

			const raw = palette.input.value;
			const space = raw.indexOf(" ");
			const query = (space < 0 ? raw : raw.slice(0, space)).trim().toLowerCase();
			const rows = LOCAL_COMMANDS.filter((row) => matches(query, `${row.name} ${row.desc}`));

			palette.items = rows;
			if (palette.index >= rows.length) palette.index = Math.max(0, rows.length - 1);

			rows.forEach((row, i) => {
				const item = document.createElement("div");
				item.setAttribute("data-dvim-palette-item", "");
				if (i === palette.index) item.setAttribute("data-selected", "");
				const name = document.createElement("span");
				name.textContent = row.name;
				const desc = document.createElement("span");
				desc.textContent = row.desc;
				item.append(name, desc);
				item.addEventListener("mousedown", (event) => {
					event.preventDefault();
					palette.index = i;
					runPalette();
				});
				palette.list.appendChild(item);
			});
		}

		function openPalette() {
			ensurePalette();
			palette.mode = "commands";
			palette.open = true;
			palette.index = 0;
			palette.input.hidden = false;
			palette.input.value = "";
			palette.el.hidden = false;
			renderPalette();
			palette.input.focus();
		}

		function closePalette() {
			if (!palette.el) return;
			palette.open = false;
			palette.el.hidden = true;
			palette.input.blur();
			state.region = "main";
			renderBar();
		}

		/** :help 用同一个浮层，只把输入行藏起来。 */
		function showHelp() {
			ensurePalette();
			palette.mode = "help";
			palette.open = true;
			palette.input.hidden = true;
			palette.el.hidden = false;
			renderPalette();
			palette.input.blur();
		}

		function completeItem() {
			const row = palette.items[palette.index];
			if (!row) return;
			palette.input.value = `${row.name} `;
			palette.index = 0;
			renderPalette();
		}

		async function runPalette() {
			const row = palette.items[palette.index];
			closePalette();

			if (!row) return;
			if (row.name === "help") {
				showHelp();
				return;
			}
			if (row.name === "reload") {
				location.reload();
				return;
			}
			if (row.name === "q") {
				if (runtime && runtime.shortcuts) runtime.shortcuts.closeWindow();
			}
		}

		function paletteKey(event) {
			if (event.key === "Escape") {
				consume(event);
				closePalette();
				return true;
			}
			if (event.key === "Enter") {
				consume(event);
				runPalette();
				return true;
			}
			if (event.key === "Tab") {
				consume(event);
				completeItem();
				return true;
			}
			if (event.key === "ArrowDown") {
				consume(event);
				palette.index = Math.min(palette.items.length - 1, palette.index + 1);
				renderPalette();
				return true;
			}
			if (event.key === "ArrowUp") {
				consume(event);
				palette.index = Math.max(0, palette.index - 1);
				renderPalette();
				return true;
			}
			return false;
		}

		// ---------------------------------------------------------------
		// 装配
		// ---------------------------------------------------------------

		function install() {
			styleEl = document.createElement("style");
			styleEl.textContent = `
[data-dvim-cursor]{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff) !important;outline-offset:2px !important;border-radius:4px}
[data-dvim-bar]{position:fixed;left:12px;bottom:12px;z-index:2147483000;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 8px;border-radius:6px;background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-1,#1b1f27));color:var(--dsw-alias-label-secondary,#8f9bad);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));opacity:.88;pointer-events:none;letter-spacing:.02em;white-space:pre}
[data-dvim-palette]{position:fixed;top:12vh;left:50%;transform:translateX(-50%);width:min(864px,72vw);z-index:2147483001;display:flex;flex-direction:column;border-radius:10px;overflow:hidden;background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-1,#1b1f27));border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));box-shadow:0 12px 32px rgba(0,0,0,.28);font-family:var(--dsw-font-family,inherit)}
[data-dvim-palette][hidden]{display:none}
[data-dvim-palette-input]{appearance:none;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#e8edf5);font:14px/1.6 var(--dsw-font-family,inherit);padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2))}
[data-dvim-palette-input][hidden]{display:none}
[data-dvim-palette-list]{max-height:48vh;overflow:auto;padding:4px}
[data-dvim-palette-item]{display:flex;gap:12px;align-items:baseline;padding:6px 10px;border-radius:6px;color:var(--dsw-alias-label-primary,#e8edf5);font-size:13px;cursor:default}
[data-dvim-palette-item]>span:first-child{min-width:96px;font-weight:600}
[data-dvim-palette-item]>span:last-child{color:var(--dsw-alias-label-secondary,#8f9bad);font-size:12px}
[data-dvim-palette-item][data-selected]{background:var(--dsw-alias-brand-primary,#3d6ef5);color:#fff}
[data-dvim-palette-item][data-selected]>span:last-child{color:rgba(255,255,255,.85)}
[data-dvim-hint]{position:fixed;inset:0;z-index:2147483002;pointer-events:none}
[data-dvim-hint-label]{position:absolute;font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 4px;border-radius:4px;background:var(--dsw-alias-brand-primary,#3d6ef5);color:#fff;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.25));box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:none}
`;
			document.head.appendChild(styleEl);

			bar = document.createElement("div");
			bar.setAttribute("data-dvim-bar", "");
			bar.textContent = "NORMAL  中栏 -/-";
			document.body.appendChild(bar);
		}

		function apply(ctx) {
			ctx.effect(() => {
				runtime = ctx;
				install();
				state.region = "main";
				paint();

				const listener = (event) => onKeyDown(event);
				// 只有鼠标点进可编辑元素才算「我要打字」；键盘切换页面不再改模式。
				const pointerListener = (event) => {
					setMode(isEditable(event.target) ? "insert" : "normal");
				};
				window.addEventListener("keydown", listener, true);
				window.addEventListener("pointerdown", pointerListener, true);
				const resizeListener = () => positionBar();
				window.addEventListener("resize", resizeListener);

				return () => {
					window.removeEventListener("keydown", listener, true);
					window.removeEventListener("pointerdown", pointerListener, true);
					window.removeEventListener("resize", resizeListener);
					clearTimeout(state.timer);
					clearTimeout(state.noticeTimer);
					cancelHints();
					if (bar) bar.remove();
					if (styleEl) styleEl.remove();
					if (palette.el) palette.el.remove();
					palette.el = null;
					palette.input = null;
					palette.list = null;
					palette.open = false;
					runtime = null;
					bar = null;
					styleEl = null;
				};
			});
		}

		exports.apply = apply;
		exports.inject = [];

		return module.exports;
	}
});
