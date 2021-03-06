import { NodePath, PluginPass } from '@babel/core';
import * as t from '@babel/types';
import { dirname, relative } from 'path';
import slash from 'slash';
import { printError } from '../lib/print';
import { CodegenContext } from '../lib/types';

export type CallExpressionPathPairs = [
  path: NodePath<t.CallExpression>,
  value: string,
][];

export type PendingDeletion = {
  specifier:
    | t.ImportSpecifier
    | t.ImportDefaultSpecifier
    | t.ImportNamespaceSpecifier;
  path: NodePath<t.ImportDeclaration>;
}[];

export type VisitedCallExpressionResults = {
  pendingDeletion: PendingDeletion;
  callExpressionPathPairs: CallExpressionPathPairs;
  hasError: boolean;
};

const IMPORT_NAME = 'graphql-let';

export function getPathsFromState(state: PluginPass) {
  const { cwd } = state;
  const sourceFullPath = state.file.opts.filename;
  if (!sourceFullPath)
    throw new Error(
      `Couldn't find source path to traversal. Check "${JSON.stringify(
        state,
      )}"`,
    );

  const sourceRelPath = relative(cwd, sourceFullPath);
  return { cwd, sourceFullPath, sourceRelPath };
}

export function getProgramPath(p: NodePath<any>): NodePath<t.Program> {
  if (!p) throw new Error('What?');
  const ancestories = p.getAncestry() as any;
  return ancestories[ancestories.length - 1]!;
}

export function getArgumentString(path: NodePath<t.CallExpression>): string {
  let value = '';
  path.traverse({
    TemplateLiteral(path: NodePath<t.TemplateLiteral>) {
      if (path.node.quasis.length !== 1) {
        printError(
          new Error(
            `TemplateLiteral of the argument must not contain arguments.`,
          ),
        );
        return;
      }
      value = path.node.quasis[0].value.raw;
    },
    StringLiteral(path: NodePath<t.StringLiteral>) {
      value = path.node.value;
    },
  });
  if (!value) printError(new Error(`Argument Check the argument.`));
  return value;
}

export function visitFromCallExpressionPaths(
  gqlCallExpressionPaths: NodePath<t.CallExpression>[],
) {
  const literalCallExpressionPaths: CallExpressionPathPairs = [];
  for (const path of gqlCallExpressionPaths) {
    const value = getArgumentString(path);
    if (value) literalCallExpressionPaths.push([path, value]);
  }
  return literalCallExpressionPaths;
}

export function removeImportDeclaration(
  pendingDeletion: VisitedCallExpressionResults['pendingDeletion'],
) {
  for (const { path: pathToRemove } of pendingDeletion) {
    if (pathToRemove.node.specifiers.length === 1) {
      pathToRemove.remove();
    } else {
      pathToRemove.node.specifiers = pathToRemove.node.specifiers.filter(
        (specifier) => {
          return specifier !== specifier;
        },
      );
    }
  }
}

export function modifyLiteralCalls(
  programPath: NodePath<t.Program>,
  sourceFullPath: string,
  CallExpressionPaths: CallExpressionPathPairs,
  codegenContext: CodegenContext[],
) {
  if (CallExpressionPaths.length !== codegenContext.length)
    throw new Error('what');
  for (const [i, [callExpressionPath]] of CallExpressionPaths.entries()) {
    const { gqlHash, tsxFullPath } = codegenContext[i]!;
    const tsxRelPathFromSource =
      './' + slash(relative(dirname(sourceFullPath), tsxFullPath));

    const localVarName = `V${gqlHash}`;

    const importNode = t.importDeclaration(
      [t.importNamespaceSpecifier(t.identifier(localVarName))],
      t.valueToNode(tsxRelPathFromSource),
    );

    programPath.unshiftContainer('body', importNode);
    callExpressionPath.replaceWithSourceString(localVarName);
  }
}

export function visitFromProgramPath(
  programPath: NodePath<t.Program>,
): VisitedCallExpressionResults {
  const pendingDeletion: PendingDeletion = [];
  const literalCallExpressionPaths: CallExpressionPathPairs = [];
  let hasError = false;
  const localNames: string[] = [];

  programPath.traverse({
    ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
      try {
        const pathValue = path.node.source.value;
        if (pathValue === IMPORT_NAME) {
          for (const specifier of path.node.specifiers) {
            if (!t.isImportSpecifier(specifier)) continue;
            localNames.push(specifier.local.name);
            pendingDeletion.push({ specifier, path });
          }
        }
      } catch (e) {
        printError(e);
        hasError = true;
      }
    },
  });

  // If no use of our library, abort quickly.
  if (!localNames.length)
    return {
      callExpressionPathPairs: literalCallExpressionPaths,
      hasError,
      pendingDeletion,
    };

  function processTargetCalls(
    path: NodePath<t.CallExpression>,
    nodeName: string,
  ) {
    if (
      localNames.some((name) => {
        return t.isIdentifier((path.get(nodeName) as any).node, { name });
      })
    ) {
      const value = getArgumentString(path);
      if (!value) printError(new Error(`Check argument.`));
      literalCallExpressionPaths.push([path, value]);
    }
  }

  programPath.traverse({
    CallExpression(path: NodePath<t.CallExpression>) {
      try {
        processTargetCalls(path, 'callee');
      } catch (e) {
        printError(e);
        hasError = true;
      }
    },
  });

  return {
    pendingDeletion,
    callExpressionPathPairs: literalCallExpressionPaths,
    hasError,
  };
}
