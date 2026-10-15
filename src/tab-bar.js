// The bottom tab bar on phones (800px wide and below). On wider screens the
// bar is hidden and the section list sits beside the map as before.
//
// To add a tab: add an entry below, give its content element in index.html
// the matching data-tab-panel attribute, and its id here as `panel`.
//
// - id:    short name, used in #app's data-active-tab attribute
// - label: text shown under the icon (always visible)
// - panel: id of the element shown over the map while this tab is active,
//          or null for the Map tab, which shows the map itself
// - icon:  24x24 SVG content. Parts with class "tab-icon-shape" are filled
//          in when the tab is active; parts with class "tab-icon-detail"
//          stay as lines drawn on top of that fill.
export const TABS = [
  {
    id: "map",
    label: "Map",
    panel: null,
    icon:
      '<path class="tab-icon-shape" d="M9 4 3.5 6.2v13.6L9 17.6l6 2.4 5.5-2.2V4.2L15 6.4Z" />' +
      '<path class="tab-icon-detail" d="M9 4v13.6M15 6.4V20" />'
  },
  {
    id: "sections",
    label: "Sections",
    panel: "sectionsPanel",
    icon:
      '<rect class="tab-icon-shape" x="4" y="3.5" width="16" height="17" rx="2.5" />' +
      '<path class="tab-icon-detail" d="M8 9h8M8 12.5h8M8 16h5" />'
  }
];

export const DEFAULT_TAB = "map";

// Builds the tabs inside `bar` (role="tablist") and returns
// { showTab, isShowing }.
//
// showTab(id) switches tabs immediately (no animation between tab content).
// If focus was inside content that is now hidden, it moves to the new tab,
// unless { moveFocus: false } is passed because the caller moves it itself.
//
// isShowing() is true when the bar is on screen (phones). The width at which
// that happens is set in mobile-panel.css only, not repeated here.
export function createTabBar(bar, app, tabs = TABS) {
  const buttons = new Map();

  bar.setAttribute("role", "tablist");

  for (const tab of tabs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab-btn";
    button.dataset.tab = tab.id;
    button.setAttribute("role", "tab");
    button.innerHTML =
      `<svg class="tab-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${tab.icon}</svg>` +
      `<span class="tab-label"></span>`;
    button.querySelector(".tab-label").textContent = tab.label;
    button.addEventListener("click", () => showTab(tab.id));

    bar.appendChild(button);
    buttons.set(tab.id, button);
  }

  // Standard tab keys: Left/Right move to the previous/next tab (wrapping
  // around), Home/End to the first/last. Only the current tab is in the Tab
  // order, so Tab moves on past the bar.
  bar.addEventListener("keydown", (event) => {
    const index = tabs.findIndex((tab) => tab.id === app.dataset.activeTab);
    const last = tabs.length - 1;
    const next = {
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowRight: index === last ? 0 : index + 1,
      Home: 0,
      End: last
    }[event.key];

    if (next === undefined) return;

    event.preventDefault();
    showTab(tabs[next].id);
    buttons.get(tabs[next].id).focus();
  });

  function showTab(id, { moveFocus = true } = {}) {
    if (!buttons.has(id)) return;

    const focusWasInHiddenPanel = tabs.some((tab) => {
      const panel = tab.panel && document.getElementById(tab.panel);
      return tab.id !== id && panel?.contains(document.activeElement);
    });

    app.dataset.activeTab = id;

    for (const tab of tabs) {
      const active = tab.id === id;
      const button = buttons.get(tab.id);

      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;

      if (tab.panel) {
        document.getElementById(tab.panel)?.classList.toggle("tab-panel-active", active);
      }
    }

    if (focusWasInHiddenPanel && moveFocus) buttons.get(id).focus();
  }

  function isShowing() {
    return getComputedStyle(bar).display !== "none";
  }

  showTab(DEFAULT_TAB);

  return { showTab, isShowing };
}
