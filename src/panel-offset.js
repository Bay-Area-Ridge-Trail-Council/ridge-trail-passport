// Keeping a selected section clear of the detail panel. Plain arithmetic
// with no map or page access, so it can be tested. ui.js measures the page
// and map.js moves the map.

// The smallest clear space (in pixels) worth moving a section into. Small
// enough for the band above the sheet on a phone held sideways.
const MIN_CLEAR_PX = 80;

// How close (in pixels) a section may come to the edge of the clear area and
// still count as fully visible.
const VISIBLE_MARGIN_PX = 8;

// Given the on-screen boxes of the map, the open detail panel, and the page
// header, returns how many pixels of each map edge are covered
// ({ top, right, bottom, left }). Returns null when the panel is closed or
// leaves no usable clear space; the map then does not move to avoid it.
//
// The panel sits over the left side of the map (the card on desktop) or
// across its bottom (the sheet on phones). Rather than guess which from the
// screen size, this looks at the space the panel leaves: if there is a
// usable strip beside it, the section goes there; otherwise above it.
//
// The header only counts where it floats over the map (phones); on desktop
// it sits beside the map.
export function coveredEdges(map, panel, header) {
  if (!map || !panel || !overlaps(panel, map)) return null;

  const top = header && overlaps(header, map)
    ? Math.max(0, header.bottom - map.top)
    : 0;

  const panelBeside = { top, right: 0, bottom: 0, left: panel.right - map.left };
  const panelBelow = { top, right: 0, bottom: map.bottom - panel.top, left: 0 };

  if (isUsable(map, panelBeside)) return panelBeside;
  if (isUsable(map, panelBelow)) return panelBelow;
  return null;
}

// Given a section's on-screen box (in map pixels), the map's size and the
// covered edges, returns how far to move the view [x, y] so the section is
// centred in the clear area, or null if it is already fully visible there.
// A section bigger than the clear area is centred as well as possible.
export function panOffset(box, width, height, covered) {
  const clear = {
    left: covered.left + VISIBLE_MARGIN_PX,
    top: covered.top + VISIBLE_MARGIN_PX,
    right: width - covered.right - VISIBLE_MARGIN_PX,
    bottom: height - covered.bottom - VISIBLE_MARGIN_PX
  };

  const alreadyVisible =
    box.left >= clear.left &&
    box.right <= clear.right &&
    box.top >= clear.top &&
    box.bottom <= clear.bottom;

  if (alreadyVisible) return null;

  return [
    (box.left + box.right) / 2 - (clear.left + clear.right) / 2,
    (box.top + box.bottom) / 2 - (clear.top + clear.bottom) / 2
  ];
}

function overlaps(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// True if the map left uncovered is big enough to be worth using.
function isUsable(map, covered) {
  const width = map.right - map.left - covered.left - covered.right;
  const height = map.bottom - map.top - covered.top - covered.bottom;

  return width >= MIN_CLEAR_PX && height >= MIN_CLEAR_PX;
}
