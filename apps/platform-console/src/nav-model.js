/** @typedef {{ id: string, label: string, panel: string, section?: string | null, requiresData?: boolean }} ConsoleNavLeaf */
/** @typedef {{ id: string, label: string, children: ConsoleNavLeaf[] }} ConsoleNavGroup */
/** @typedef {ConsoleNavLeaf | ConsoleNavGroup} ConsoleNavItem */

/** @type {ConsoleNavItem[]} */
export const CONSOLE_NAV = [
  {
    id: "overview",
    label: "Overview",
    panel: "overview",
    section: null,
    requiresData: true
  },
  {
    id: "catalog",
    label: "Catalog",
    children: [
      { id: "responders", label: "Responders", panel: "responders", section: "responders", requiresData: true },
      { id: "hotlines", label: "Hotlines", panel: "hotlines", section: "hotlines", requiresData: true },
      { id: "marketplace", label: "Marketplace", panel: "catalog", section: null, requiresData: true }
    ]
  },
  {
    id: "operations",
    label: "Operations",
    children: [
      { id: "reviews", label: "Review Queue", panel: "reviews", section: "reviews", requiresData: true },
      { id: "requests", label: "Requests", panel: "requests", section: "requests", requiresData: true }
    ]
  },
  {
    id: "billing",
    label: "Billing",
    panel: "billing",
    section: "billing",
    requiresData: true
  },
  {
    id: "audit",
    label: "Audit Trail",
    panel: "audit",
    section: "audit",
    requiresData: true
  },
  {
    id: "settings",
    label: "Settings",
    children: [
      { id: "session", label: "Session & Unlock", panel: "session", section: null, requiresData: false },
      { id: "credentials", label: "Gateway Credentials", panel: "credentials", section: null, requiresData: false }
    ]
  }
];

export const DEFAULT_PANEL = "overview";

export const DEFAULT_EXPANDED_GROUPS = ["catalog", "operations", "settings"];

/** @returns {ConsoleNavLeaf[]} */
export function flattenNavLeaves(items = CONSOLE_NAV) {
  /** @type {ConsoleNavLeaf[]} */
  const leaves = [];
  for (const item of items) {
    if ("children" in item) {
      leaves.push(...item.children);
    } else {
      leaves.push(item);
    }
  }
  return leaves;
}

/** @param {string} panelId @returns {ConsoleNavLeaf | null} */
export function findNavLeaf(panelId) {
  return flattenNavLeaves().find((leaf) => leaf.panel === panelId) || null;
}

/** @param {string | null | undefined} section @returns {ConsoleNavLeaf | null} */
export function findNavLeafBySection(section) {
  if (!section) {
    return null;
  }
  return flattenNavLeaves().find((leaf) => leaf.section === section) || null;
}

/**
 * @param {object} options
 * @param {string} options.activePanel
 * @param {Set<string>} options.expandedGroups
 * @param {boolean} options.dataReady
 */
export function renderSidebarMarkup({ activePanel, expandedGroups, dataReady }) {
  const renderLeaf = (leaf) => {
    const disabled = leaf.requiresData && !dataReady;
    const active = activePanel === leaf.panel;
    return `
      <button
        type="button"
        class="nav-leaf${active ? " is-active" : ""}${disabled ? " is-disabled" : ""}"
        data-nav-panel="${leaf.panel}"
        ${disabled ? 'aria-disabled="true"' : ""}
      >
        <span>${leaf.label}</span>
      </button>
    `;
  };

  return CONSOLE_NAV.map((item) => {
    if ("children" in item) {
      const expanded = expandedGroups.has(item.id);
      const childActive = item.children.some((child) => child.panel === activePanel);
      return `
        <div class="nav-group${expanded || childActive ? " is-expanded" : ""}" data-nav-group="${item.id}">
          <button type="button" class="nav-group-toggle" data-nav-group-toggle="${item.id}" aria-expanded="${expanded || childActive}">
            <span class="nav-group-label">${item.label}</span>
            <span class="nav-group-chevron" aria-hidden="true"></span>
          </button>
          <div class="nav-group-children">
            ${item.children.map((child) => renderLeaf(child)).join("")}
          </div>
        </div>
      `;
    }
    return `
      <div class="nav-group nav-group--leaf">
        ${renderLeaf(item)}
      </div>
    `;
  }).join("");
}

/** @param {string} panelId @returns {{ title: string, description: string }} */
export function panelMeta(panelId) {
  const meta = {
    overview: {
      title: "Overview",
      description: "Platform health summary and operator gateway status."
    },
    responders: {
      title: "Responders",
      description: "Registered responders, review state, and enable/disable actions."
    },
    hotlines: {
      title: "Hotlines",
      description: "Hotline catalog entries and operator lifecycle controls."
    },
    catalog: {
      title: "Marketplace Catalog",
      description: "Public-facing hotline directory exposed by the platform."
    },
    reviews: {
      title: "Review Queue",
      description: "Pending responder and hotline submissions awaiting operator action."
    },
    requests: {
      title: "Requests",
      description: "Delegated execution requests and runtime oversight."
    },
    billing: {
      title: "Billing",
      description: "Tenant balance, manual recharge, and ledger inspection."
    },
    audit: {
      title: "Audit Trail",
      description: "Operator and system actions recorded for accountability."
    },
    session: {
      title: "Session & Unlock",
      description: "Initialize or unlock the local operator gateway passphrase session."
    },
    credentials: {
      title: "Gateway Credentials",
      description: "Configure the platform API endpoint and admin credential proxy."
    },
    detail: {
      title: "Selection Detail",
      description: "Focused detail for the selected responder, hotline, request, or review item."
    }
  };
  return meta[panelId] || { title: "Platform Console", description: "Operator control surface." };
}
