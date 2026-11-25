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

export default {
  meta: { name: "kikoto" },
  rules: {
    "no-effect-cancel-flag": noEffectCancelFlag,
    "no-effect-abort-controller": noEffectAbortController,
  },
};
