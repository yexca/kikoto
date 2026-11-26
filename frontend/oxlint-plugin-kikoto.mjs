// Project rules for Oxlint. Each rule guards a pattern that spreads by copying
// from neighbouring files; docs/development/frontend-guidelines.md describes
// the shared way that replaces it.

const effectHooks = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

function isFunction(node) {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return "";
}

/** The callback of `useEffect(callback, deps)` and its layout variants, if `node` is one. */
function isEffectCallback(node) {
  const parent = node.parent;
  return (
    isFunction(node) &&
    parent?.type === "CallExpression" &&
    parent.arguments[0] === node &&
    effectHooks.has(calleeName(parent.callee))
  );
}

function enclosingEffect(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (isEffectCallback(current)) return current;
  }
  return null;
}

/** Visits the nodes of `root` without entering nested functions. */
function visitOwnScope(root, visit) {
  const stack = [root.body];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node.type !== "string") continue;
    visit(node);
    if (isFunction(node) || node.type === "FunctionDeclaration") continue;
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value.type === "string") stack.push(value);
    }
  }
}

function visitAll(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node.type !== "string") continue;
    visit(node);
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value.type === "string") stack.push(value);
    }
  }
}

/** The cleanup functions an effect callback returns. */
function cleanupFunctions(effect) {
  if (isFunction(effect.body)) return [effect.body];
  const named = new Map();
  const returned = [];
  visitOwnScope(effect, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && isFunction(node.init)) {
      named.set(node.id.name, node.init);
    }
    if (node.type === "FunctionDeclaration" && node.id) named.set(node.id.name, node);
    if (node.type === "ReturnStatement" && node.argument) returned.push(node.argument);
  });
  return returned.flatMap((argument) => {
    if (isFunction(argument)) return [argument];
    if (argument.type === "Identifier" && named.has(argument.name)) return [named.get(argument.name)];
    return [];
  });
}

const noEffectCancelFlag = {
  meta: {
    type: "problem",
    docs: { description: "Effects cancel loads and listeners through lib/effectScope, not a flag the cleanup flips." },
  },
  create(context) {
    return {
      ArrowFunctionExpression: check,
      FunctionExpression: check,
    };
    function check(effect) {
      if (!isEffectCallback(effect)) return;
      const flags = new Map();
      visitOwnScope(effect, (node) => {
        if (node.type !== "VariableDeclaration" || node.kind !== "let") return;
        for (const declarator of node.declarations) {
          if (
            declarator.id.type === "Identifier" &&
            declarator.init?.type === "Literal" &&
            typeof declarator.init.value === "boolean"
          ) {
            flags.set(declarator.id.name, declarator);
          }
        }
      });
      if (flags.size === 0) return;
      const reported = new Set();
      for (const cleanup of cleanupFunctions(effect)) {
        visitAll(cleanup, (node) => {
          if (
            node.type !== "AssignmentExpression" ||
            node.left.type !== "Identifier" ||
            !flags.has(node.left.name) ||
            reported.has(node.left.name)
          ) {
            return;
          }
          reported.add(node.left.name);
          context.report({
            node: flags.get(node.left.name),
            message: `Cancel the effect's load or listener with startLoad or createEffectScope from @/lib/effectScope instead of the \`${node.left.name}\` flag (docs/development/frontend-guidelines.md#async-effects).`,
          });
        });
      }
    }
  },
};

const noEffectAbortController = {
  meta: {
    type: "problem",
    docs: { description: "Effects own their abort signal through lib/effectScope." },
  },
  create(context) {
    return {
      NewExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "AbortController") return;
        if (!enclosingEffect(node)) return;
        context.report({
          node,
          message:
            "Run the effect's load or listener with startLoad or createEffectScope from @/lib/effectScope, which owns the abort signal (docs/development/frontend-guidelines.md#async-effects).",
        });
      },
    };
  },
};

const sharedAreas = ["components/", "hooks/", "lib/"];
const aboveShared = ["features/", "pages/", "app/", "player/"];
const aboveUI = ["components/", "hooks/", "auth/"];
const domainAreas = ["features/", "player/"];
const shellAreas = ["app/", "pages/"];

/**
 * Deep imports from one feature into another that predate the rule. Each key
 * is a file under src/ and each value the src/-relative modules it may still
 * reach. Remove an entry when the import moves to a shared contract; never
 * add one.
 */
export const crossFeatureAllowance = {
  "features/rankings/RankingSettings.tsx": ["features/workflows/LatestRunStatus", "features/workflows/useLatestRun"],
  "features/subscriptions/SubscriptionManager.tsx": [
    "features/workflows/LatestRunStatus",
    "features/workflows/runPresentation",
    "features/workflows/useLatestRun",
  ],
  "features/workflows/availability-watch/AvailabilityWatchTargetCard.tsx": ["features/work-detail/workDetailShared"],
};

/** The path of `filename` below its `src/` directory, or "" outside one. */
function sourcePath(filename) {
  const normalized = filename.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/src/");
  return index === -1 ? "" : normalized.slice(index + "/src/".length);
}

/** The src/-relative module `specifier` names from `file`, or "" for a package or a path outside src/. */
function resolveSource(file, specifier) {
  if (specifier.startsWith("@/")) return specifier.slice(2);
  if (!specifier.startsWith(".")) return "";
  const parts = file.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return "";
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

function featureOf(module) {
  const [area, name] = module.split("/");
  return area === "features" ? name : "";
}

/** Why `file` may not import `target`, or "" when the direction holds. */
function directionViolation(file, target) {
  if (
    file.startsWith("components/ui/") &&
    aboveUI.some((area) => target.startsWith(area)) &&
    !target.startsWith("components/ui/")
  ) {
    return `components/ui is the bottom layer and never imports ${target}; pass it in from the caller.`;
  }
  if (sharedAreas.some((area) => file.startsWith(area)) && aboveShared.some((area) => target.startsWith(area))) {
    return `Shared code (components, hooks, lib) never imports ${target}; move what it needs into shared code or pass it in from the caller.`;
  }
  if (domainAreas.some((area) => file.startsWith(area)) && shellAreas.some((area) => target.startsWith(area))) {
    return `Features and the player never import the app shell or pages (${target}); move what they need into shared code or pass it in from the caller.`;
  }
  const owner = featureOf(file);
  const reached = featureOf(target);
  if (!owner || !reached || owner === reached) return "";
  const rest = target.split("/").slice(2);
  if (rest.length === 0 || (rest.length === 1 && rest[0] === "index")) return "";
  if (crossFeatureAllowance[file]?.includes(target)) return "";
  return `features/${owner} reaches into another feature's internals (${target}); compose them from a page, extract a shared contract, or import the feature's public entry.`;
}

const dependencyDirection = {
  meta: {
    type: "problem",
    docs: { description: "Imports follow app and routes -> features -> shared -> components/ui." },
  },
  create(context) {
    const file = sourcePath(context.filename);
    if (!file) return {};
    function check(node, source) {
      if (source?.type !== "Literal" || typeof source.value !== "string") return;
      const target = resolveSource(file, source.value);
      if (!target) return;
      const violation = directionViolation(file, target);
      if (violation) {
        context.report({ node: source, message: `${violation} (frontend/AGENTS.md#dependency-direction)` });
      }
    }
    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
    };
  },
};

/**
 * Whether `text` styles a loading placeholder by hand: a bare `animate-pulse`
 * with a fill. A pulsing icon or a `motion-safe:` progress pulse is not one.
 */
function isInlineSkeleton(text) {
  const tokens = text.split(/\s+/u);
  return tokens.includes("animate-pulse") && tokens.some((token) => token.startsWith("bg-"));
}

const noInlineSkeleton = {
  meta: {
    type: "problem",
    docs: { description: "Loading placeholders are drawn with the Skeleton primitive." },
  },
  create(context) {
    if (sourcePath(context.filename) === "components/ui/skeleton.tsx") return {};
    function report(node) {
      context.report({
        node,
        message:
          'Draw the loading placeholder with Skeleton from "@/components/ui/skeleton" (reveal on its outermost block) instead of animate-pulse classes (docs/architecture/frontend/navigation-and-history.md).',
      });
    }
    return {
      Literal(node) {
        if (typeof node.value === "string" && isInlineSkeleton(node.value)) report(node);
      },
      TemplateLiteral(node) {
        if (isInlineSkeleton(node.quasis.map((quasi) => quasi.value.cooked ?? "").join(" "))) report(node);
      },
    };
  },
};

const browserStorageNames = new Set(["localStorage", "sessionStorage"]);

/** Whether `node` names a variable rather than a property, a key, or a type. */
function isReference(node) {
  const parent = node.parent;
  if (!parent) return true;
  if (parent.type === "MemberExpression") return parent.object === node || parent.computed;
  if (
    (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
    parent.key === node &&
    !parent.computed
  ) {
    return parent.type === "Property" && parent.shorthand;
  }
  return !parent.type.startsWith("TS") && !parent.type.endsWith("Specifier");
}

function memberName(node) {
  if (!node.computed) return node.property.type === "Identifier" ? node.property.name : "";
  return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : "";
}

const noDirectStorage = {
  meta: {
    type: "problem",
    docs: {
      description: "Browser storage is read and written through lib/clientStorage, which names each key's scope.",
    },
  },
  create(context) {
    if (sourcePath(context.filename) === "lib/clientStorage.ts") return {};
    function report(node, name) {
      context.report({
        node,
        message: `Use localStore or sessionStore from "@/lib/clientStorage" with a deviceKey, serverKey, or accountKey instead of ${name}, so the key's scope is chosen explicitly (docs/architecture/frontend/interaction-principles.md#client-storage).`,
      });
    }
    return {
      Identifier(node) {
        if (browserStorageNames.has(node.name) && isReference(node)) report(node, node.name);
      },
      MemberExpression(node) {
        const name = memberName(node);
        if (browserStorageNames.has(name)) report(node, name);
      },
    };
  },
};

export default {
  meta: { name: "kikoto" },
  rules: {
    "no-effect-cancel-flag": noEffectCancelFlag,
    "no-effect-abort-controller": noEffectAbortController,
    "dependency-direction": dependencyDirection,
    "no-inline-skeleton": noInlineSkeleton,
    "no-direct-storage": noDirectStorage,
  },
};
