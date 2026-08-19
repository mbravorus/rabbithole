const STORAGE_KEY = "rabbithole-icon-studio-v1";
const PAGE_SIZE = 120;
const state = {
  iconSet: null,
  iconNames: [],
  roles: [],
  saved: {},
  draft: {},
  activeRole: "",
  query: "",
  roleQuery: "",
  style: "all",
  sort: "recommended",
  visible: PAGE_SIZE,
  shortlist: new Set(),
  shortlistOpen: false,
  applying: false,
};

const elements = {};

start().catch((error) => {
  document.getElementById("loading").innerHTML = `<strong>Icon Studio could not start.</strong><p>${escapeHtml(error?.message || String(error))}</p>`;
});

async function start() {
  cacheElements();
  const response = await fetch("/api/bootstrap");
  if (!response.ok) throw new Error("Could not load the local Ionicons catalog.");
  const data = await response.json();
  state.iconSet = data.iconSet;
  state.iconNames = Object.keys(data.iconSet.icons);
  state.roles = data.roles;
  state.saved = { ...data.selections };
  restoreLocalState();
  state.activeRole ||= state.roles[0].name;
  bindEvents();
  renderAll();
  elements.loading.hidden = true;
  elements.app.hidden = false;
}

function cacheElements() {
  for (const id of [
    "loading", "app", "save-state", "reset-button", "export-button", "apply-button",
    "progress-label", "change-count", "progress-ring", "role-filter", "role-list",
    "role-group", "role-title", "role-description", "role-position", "previous-role",
    "next-role", "preview-light", "preview-dark", "preview-detail", "selected-icon-name",
    "icon-search", "shortlist-toggle", "shortlist-count", "shortlist-panel", "shortlist-items",
    "result-title", "result-count", "sort-select", "icon-grid", "load-more", "empty-state",
    "clear-search", "apply-dialog", "apply-summary", "apply-changes", "confirm-apply",
    "toast-region",
  ]) elements[toCamel(id)] = document.getElementById(id);
}

function bindEvents() {
  elements.roleFilter.addEventListener("input", () => {
    state.roleQuery = elements.roleFilter.value.trim().toLowerCase();
    renderRoles();
  });
  elements.iconSearch.addEventListener("input", () => {
    state.query = elements.iconSearch.value.trim().toLowerCase();
    state.visible = PAGE_SIZE;
    renderExplorer();
  });
  document.querySelector(".segmented").addEventListener("click", (event) => {
    const button = event.target.closest("[data-style]");
    if (!button) return;
    state.style = button.dataset.style;
    state.visible = PAGE_SIZE;
    document.querySelectorAll("[data-style]").forEach((item) => item.classList.toggle("active", item === button));
    renderExplorer();
  });
  elements.sortSelect.addEventListener("change", () => {
    state.sort = elements.sortSelect.value;
    renderExplorer();
  });
  elements.previousRole.addEventListener("click", () => moveRole(-1));
  elements.nextRole.addEventListener("click", () => moveRole(1));
  elements.loadMore.addEventListener("click", () => {
    state.visible += PAGE_SIZE;
    renderExplorer();
  });
  elements.clearSearch.addEventListener("click", clearFilters);
  elements.shortlistToggle.addEventListener("click", () => {
    state.shortlistOpen = !state.shortlistOpen;
    renderShortlist();
  });
  elements.resetButton.addEventListener("click", resetDraft);
  elements.exportButton.addEventListener("click", exportSelections);
  elements.applyButton.addEventListener("click", openApplyDialog);
  elements.confirmApply.addEventListener("click", (event) => {
    event.preventDefault();
    applySelections();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "/" && !isTypingTarget(event.target)) {
      event.preventDefault();
      elements.iconSearch.focus();
    }
    if (event.key === "Escape" && document.activeElement === elements.iconSearch && elements.iconSearch.value) clearFilters();
  });
}

function renderAll() {
  renderRoles();
  renderRoleStage();
  renderExplorer();
  renderProgress();
  renderShortlist();
}

function renderRoles() {
  const groups = new Map();
  for (const role of state.roles) {
    if (state.roleQuery && !`${role.label} ${role.name} ${role.group}`.toLowerCase().includes(state.roleQuery)) continue;
    if (!groups.has(role.group)) groups.set(role.group, []);
    groups.get(role.group).push(role);
  }

  const fragment = document.createDocumentFragment();
  for (const [group, roles] of groups) {
    const heading = document.createElement("div");
    heading.className = "role-group";
    heading.textContent = group;
    fragment.append(heading);
    for (const role of roles) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "role-item";
      button.classList.toggle("active", role.name === state.activeRole);
      button.classList.toggle("changed", state.draft[role.name] !== state.saved[role.name]);
      button.innerHTML = `<span class="role-icon">${svg(state.draft[role.name], 16)}</span><span>${escapeHtml(role.label)}</span><i class="changed-dot"></i>`;
      button.addEventListener("click", () => selectRole(role.name));
      fragment.append(button);
    }
  }
  elements.roleList.replaceChildren(fragment);
}

function renderRoleStage() {
  const role = activeRole();
  const index = state.roles.findIndex(({ name }) => name === role.name);
  const selected = state.draft[role.name];
  elements.roleGroup.textContent = role.group;
  elements.roleTitle.textContent = role.label;
  elements.roleDescription.textContent = role.description;
  elements.rolePosition.textContent = `${index + 1} of ${state.roles.length}`;
  elements.previewLight.innerHTML = svg(selected, 16);
  elements.previewDark.innerHTML = svg(selected, 16);
  elements.previewDetail.innerHTML = svg(selected, 28);
  elements.selectedIconName.textContent = selected;
  document.querySelectorAll(".toolbar-neighbor[data-icon]").forEach((item) => {
    item.innerHTML = svg(item.dataset.icon, 16);
  });
}

function renderExplorer() {
  const results = filteredIcons();
  const visible = results.slice(0, state.visible);
  const selected = state.draft[state.activeRole];
  elements.resultTitle.textContent = state.query ? `Results for “${state.query}”` : state.sort === "recommended" ? `Recommended for ${activeRole().label}` : "All icons";
  elements.resultCount.textContent = `${results.length.toLocaleString()} ${results.length === 1 ? "icon" : "icons"}`;
  elements.iconGrid.hidden = visible.length === 0;
  elements.emptyState.hidden = results.length !== 0;
  elements.loadMore.hidden = visible.length >= results.length;
  if (!elements.loadMore.hidden) elements.loadMore.textContent = `Show ${Math.min(PAGE_SIZE, results.length - visible.length)} more`;

  const fragment = document.createDocumentFragment();
  for (const result of visible) {
    const card = document.createElement("div");
    card.className = "icon-card";
    card.classList.toggle("selected", result.name === selected);
    card.innerHTML = `${result.score >= 6 && state.sort === "recommended" && !state.query ? '<span class="recommended-badge">Match</span>' : ""}
      <button class="star${state.shortlist.has(result.name) ? " active" : ""}" type="button" aria-label="${state.shortlist.has(result.name) ? "Remove from" : "Add to"} shortlist">★</button>
      <button class="icon-choice" type="button" aria-label="Use ${escapeHtml(result.name)} for ${escapeHtml(activeRole().label)}">
        <span class="glyph">${svg(result.name, 28)}</span><span class="icon-name" title="${escapeHtml(result.name)}">${escapeHtml(result.name)}</span>
      </button>`;
    card.querySelector(".star").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleShortlist(result.name);
    });
    card.querySelector(".icon-choice").addEventListener("click", () => assignIcon(result.name));
    fragment.append(card);
  }
  elements.iconGrid.replaceChildren(fragment);
}

function renderProgress() {
  const changed = changes();
  elements.progressLabel.textContent = `${state.roles.length} roles`;
  elements.progressRing.querySelector("span").textContent = state.roles.length;
  elements.changeCount.textContent = changed.length ? `${changed.length} unpublished ${changed.length === 1 ? "change" : "changes"}` : "No unpublished changes";
  elements.saveState.textContent = changed.length ? "Draft saved on this device" : "All changes applied";
  elements.saveState.classList.toggle("changed", changed.length > 0);
  elements.applyButton.disabled = changed.length === 0 || state.applying;
}

function renderShortlist() {
  elements.shortlistCount.textContent = state.shortlist.size;
  elements.shortlistPanel.hidden = !state.shortlistOpen;
  elements.shortlistToggle.setAttribute("aria-expanded", String(state.shortlistOpen));
  const fragment = document.createDocumentFragment();
  for (const name of state.shortlist) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "shortlist-chip";
    button.innerHTML = `${svg(name, 18)}<span>${escapeHtml(name)}</span>`;
    button.addEventListener("click", () => assignIcon(name));
    fragment.append(button);
  }
  if (!fragment.childNodes.length) {
    const empty = document.createElement("span");
    empty.className = "shortlist-empty";
    empty.textContent = "No candidates yet";
    fragment.append(empty);
  }
  elements.shortlistItems.replaceChildren(fragment);
}

function selectRole(name) {
  state.activeRole = name;
  state.visible = PAGE_SIZE;
  state.query = "";
  elements.iconSearch.value = "";
  persistLocalState();
  renderAll();
  document.querySelector(".role-stage").scrollIntoView({ behavior: "smooth", block: "start" });
}

function moveRole(direction) {
  const index = state.roles.findIndex(({ name }) => name === state.activeRole);
  const next = (index + direction + state.roles.length) % state.roles.length;
  selectRole(state.roles[next].name);
}

function assignIcon(name) {
  state.draft[state.activeRole] = name;
  persistLocalState();
  renderRoles();
  renderRoleStage();
  renderExplorer();
  renderProgress();
  toast(`${name} selected for ${activeRole().label}`);
}

function toggleShortlist(name) {
  if (state.shortlist.has(name)) state.shortlist.delete(name);
  else state.shortlist.add(name);
  persistLocalState();
  renderExplorer();
  renderShortlist();
}

function filteredIcons() {
  const role = activeRole();
  const terms = state.query.split(/[\s_-]+/).filter(Boolean);
  const items = [];
  for (const name of state.iconNames) {
    if (!matchesStyle(name)) continue;
    const searchable = name.replaceAll("-", " ");
    if (terms.length && !terms.every((term) => searchable.includes(term))) continue;
    items.push({ name, score: recommendationScore(name, role) });
  }
  if (state.sort === "az" || (state.query && terms.length)) {
    items.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    items.sort((a, b) => b.score - a.score || styleScore(b.name) - styleScore(a.name) || a.name.localeCompare(b.name));
  }
  return items;
}

function recommendationScore(name, role) {
  const normalized = name.replaceAll("-", " ");
  let score = 0;
  role.keywords.forEach((keyword, index) => {
    const phrase = keyword.replaceAll("-", " ");
    if (normalized === phrase || name === keyword) score += 20 - index;
    else if (normalized.includes(phrase)) score += Math.max(3, 10 - index);
  });
  if (name === state.saved[role.name]) score += 4;
  if (name.endsWith("-outline")) score += 2;
  return score;
}

function matchesStyle(name) {
  if (state.style === "outline") return name.endsWith("-outline");
  if (state.style === "sharp") return name.endsWith("-sharp");
  if (state.style === "filled") return !name.endsWith("-outline") && !name.endsWith("-sharp");
  return true;
}

function styleScore(name) {
  if (name.endsWith("-outline")) return 3;
  if (!name.endsWith("-sharp")) return 2;
  return 1;
}

function clearFilters() {
  state.query = "";
  state.style = "all";
  state.visible = PAGE_SIZE;
  elements.iconSearch.value = "";
  document.querySelectorAll("[data-style]").forEach((button) => button.classList.toggle("active", button.dataset.style === "all"));
  renderExplorer();
}

function resetDraft() {
  if (!changes().length) {
    toast("Your draft already matches Rabbithole");
    return;
  }
  state.draft = { ...state.saved };
  persistLocalState();
  renderAll();
  toast("Draft reset to the applied icon set");
}

async function exportSelections() {
  const output = JSON.stringify(state.draft, null, 2);
  try {
    await navigator.clipboard.writeText(output);
    toast("Selection mapping copied to clipboard");
  } catch {
    const blob = new Blob([`${output}\n`], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "rabbithole-icon-selections.json";
    link.click();
    URL.revokeObjectURL(link.href);
    toast("Selection mapping downloaded");
  }
}

function openApplyDialog() {
  const changed = changes();
  if (!changed.length) return;
  elements.applySummary.textContent = `${changed.length} product ${changed.length === 1 ? "role" : "roles"} will be updated.`;
  elements.applyChanges.innerHTML = changed.map(({ role, next }) =>
    `<div class="apply-change"><strong>${escapeHtml(role.label)}</strong><code>${escapeHtml(next)}</code></div>`
  ).join("");
  elements.applyDialog.showModal();
}

async function applySelections() {
  if (state.applying) return;
  state.applying = true;
  elements.confirmApply.disabled = true;
  elements.confirmApply.textContent = "Rebuilding…";
  renderProgress();
  try {
    const response = await fetch("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections: state.draft }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not apply the icon set.");
    state.saved = { ...result.selections };
    state.draft = { ...result.selections };
    persistLocalState();
    elements.applyDialog.close();
    renderAll();
    toast(result.changed ? "Icon set applied and Rabbithole rebuilt" : "Icon set already applied");
  } catch (error) {
    toast(error?.message || String(error), "error");
  } finally {
    state.applying = false;
    elements.confirmApply.disabled = false;
    elements.confirmApply.textContent = "Apply & rebuild";
    renderProgress();
  }
}

function changes() {
  return state.roles.flatMap((role) => state.draft[role.name] === state.saved[role.name]
    ? []
    : [{ role, previous: state.saved[role.name], next: state.draft[role.name] }]);
}

function activeRole() {
  return state.roles.find(({ name }) => name === state.activeRole) || state.roles[0];
}

function restoreLocalState() {
  try {
    const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const names = Object.keys(state.saved);
    const validDraft = local?.draft && names.every((name) => state.iconSet.icons[local.draft[name]]);
    const validBase = local?.base && names.every((name) => typeof local.base[name] === "string");
    state.draft = { ...state.saved };
    if (validDraft && validBase) {
      for (const name of names) {
        if (local.draft[name] !== local.base[name]) state.draft[name] = local.draft[name];
      }
    }
    state.activeRole = state.roles.some(({ name }) => name === local?.activeRole) ? local.activeRole : state.roles[0].name;
    state.shortlist = new Set((local?.shortlist || []).filter((name) => state.iconSet.icons[name]));
  } catch {
    state.draft = { ...state.saved };
    state.activeRole = state.roles[0].name;
  }
}

function persistLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    base: state.saved,
    draft: state.draft,
    activeRole: state.activeRole,
    shortlist: [...state.shortlist],
  }));
}

function svg(name, size) {
  const icon = state.iconSet.icons[name];
  if (!icon) return "";
  const body = icon.body.replaceAll('stroke-width="32"', 'stroke-width="48"');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${state.iconSet.width} ${state.iconSet.height}" aria-hidden="true" focusable="false">${body}</svg>`;
}

function toast(message, kind = "") {
  const item = document.createElement("div");
  item.className = `toast ${kind}`.trim();
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 3200);
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target?.isContentEditable;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}
