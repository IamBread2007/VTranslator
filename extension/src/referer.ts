// DeclarativeNetRequest session rules for referer-based image hotlink bypass.

export interface RefererRule {
  id: number;
  priority: number;
  action: chrome.declarativeNetRequest.RuleAction;
  condition: chrome.declarativeNetRequest.RuleCondition;
}

export function buildRefererRule(
  id: number,
  imageUrl: string,
  pageUrl: string,
  opts: { initiatorDomain?: string } = {},
): RefererRule {
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    // The image itself and the XHR readers use to lazy-load it.
    urlFilter: imageUrl,
    resourceTypes: ["xmlhttprequest", "other"],
  };
  if (opts.initiatorDomain) condition.initiatorDomains = [opts.initiatorDomain];
  return {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "Referer", operation: "set", value: pageUrl }],
    },
    condition,
  };
}

const MAX_RULE_ID = 9999;
const inUse = new Set<number>();
let nextId = 1;

/**
 * Rule ids must not collide between concurrent fetches in different tabs.
 * Forward cursor first (cheap steady state), then a wraparound pass from 1 to
 * reclaim released ids; a live id can never be handed out twice.
 */
export function allocRuleId(): number {
  for (let scans = 0; scans < MAX_RULE_ID; scans++) {
    const id = nextId;
    nextId = nextId >= MAX_RULE_ID ? 1 : nextId + 1;
    if (!inUse.has(id)) {
      inUse.add(id);
      return id;
    }
  }
  throw new Error("all referer rule ids in use");
}

export function releaseRuleId(id: number): void {
  inUse.delete(id);
}
