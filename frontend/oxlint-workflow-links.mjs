// Oxlint plugin: only `src/lib/workflowLinks.ts` spells an address of Workflows.
//
// Everything else builds one with `workflowsPath`, `workflowRunPath`, or
// `WORKFLOWS_PATH`, and opens one with `openWorkflowRun` or
// `openWorkflowPath`, all from `@/lib/workflowLinks`. The configuration turns
// the rule off for that module and for tests, which assert the literal address.
//
// The rule reports two shapes:
// - a string or template literal that is an address of Workflows or has a
//   query on it, such as "/workflows" or `/workflows?run=${runId}`;
// - a `history.pushState` or `history.replaceState` call whose address
//   argument names Workflows or one of the builders above. An address the call
//   takes from a variable is not seen.

const workflowsAddress = /^\/workflows(?:$|[?#/])/;
const workflowsQuery = /\/workflows\?/;
const workflowsReference = /\/workflows|\bworkflowRunPath\b|\bworkflowsPath\b|\bWORKFLOWS_PATH\b/;

function isWorkflowsText(text) {
  return workflowsAddress.test(text) || workflowsQuery.test(text);
}

const rule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      literal:
        "Build an address of Workflows with workflowsPath, workflowRunPath, or WORKFLOWS_PATH from @/lib/workflowLinks instead of writing it out.",
      history:
        "Open Workflows with openWorkflowRun or openWorkflowPath from @/lib/workflowLinks instead of writing its address to browser history.",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && isWorkflowsText(node.value)) {
          context.report({ node, messageId: "literal" });
        }
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => isWorkflowsText(quasi.value.cooked ?? quasi.value.raw))) {
          context.report({ node, messageId: "literal" });
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return;
        if (callee.property.name !== "pushState" && callee.property.name !== "replaceState") return;
        const address = node.arguments[2];
        if (address && workflowsReference.test(context.sourceCode.getText(address))) {
          context.report({ node, messageId: "history" });
        }
      },
    };
  },
};

export default {
  meta: { name: "kikoto-workflow-links" },
  rules: { "no-handwritten-address": rule },
};
