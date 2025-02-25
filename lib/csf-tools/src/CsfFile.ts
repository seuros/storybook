/* eslint-disable no-underscore-dangle */
import fs from 'fs-extra';
import dedent from 'ts-dedent';
import * as t from '@babel/types';
import generate from '@babel/generator';
import traverse from '@babel/traverse';
import { toId, isExportStory, storyNameFromExport } from '@storybook/csf';
import { babelParse } from './babelParse';

const logger = console;
interface Meta {
  title?: string;
  component?: string;
  includeStories?: string[] | RegExp;
  excludeStories?: string[] | RegExp;
}

interface Story {
  id: string;
  name: string;
  parameters: Record<string, any>;
}

function parseIncludeExclude(prop: t.Node) {
  if (t.isArrayExpression(prop)) {
    return prop.elements.map((e) => {
      if (t.isStringLiteral(e)) return e.value;
      throw new Error(`Expected string literal: ${e}`);
    });
  }

  if (t.isStringLiteral(prop)) return new RegExp(prop.value);

  if (t.isRegExpLiteral(prop)) return new RegExp(prop.pattern, prop.flags);

  throw new Error(`Unknown include/exclude: ${prop}`);
}

const findVarInitialization = (identifier: string, program: t.Program) => {
  let init: t.Expression = null;
  let declarations: t.VariableDeclarator[] = null;
  program.body.find((node: t.Node) => {
    if (t.isVariableDeclaration(node)) {
      declarations = node.declarations;
    } else if (t.isExportNamedDeclaration(node) && t.isVariableDeclaration(node.declaration)) {
      declarations = node.declaration.declarations;
    }

    return (
      declarations &&
      declarations.find((decl: t.Node) => {
        if (
          t.isVariableDeclarator(decl) &&
          t.isIdentifier(decl.id) &&
          decl.id.name === identifier
        ) {
          init = decl.init;
          return true; // stop looking
        }
        return false;
      })
    );
  });
  return init;
};

const formatLocation = (node: t.Node, fileName?: string) => {
  const { line, column } = node.loc.start;
  return `${fileName || ''} (line ${line}, col ${column})`.trim();
};

const isArgsStory = (init: t.Expression, parent: t.Node, csf: CsfFile) => {
  let storyFn: t.Node = init;
  // export const Foo = Bar.bind({})
  if (t.isCallExpression(init)) {
    const { callee, arguments: bindArguments } = init;
    if (
      t.isProgram(parent) &&
      t.isMemberExpression(callee) &&
      t.isIdentifier(callee.object) &&
      t.isIdentifier(callee.property) &&
      callee.property.name === 'bind' &&
      (bindArguments.length === 0 ||
        (bindArguments.length === 1 &&
          t.isObjectExpression(bindArguments[0]) &&
          bindArguments[0].properties.length === 0))
    ) {
      const boundIdentifier = callee.object.name;
      const template = findVarInitialization(boundIdentifier, parent);
      if (template) {
        // eslint-disable-next-line no-param-reassign
        csf._templates[boundIdentifier] = template;
        storyFn = template;
      }
    }
  }
  if (t.isArrowFunctionExpression(storyFn)) {
    return storyFn.params.length > 0;
  }
  return false;
};

export interface CsfOptions {
  defaultTitle: string;
  fileName?: string;
}
export class CsfFile {
  _ast: t.File;

  _defaultTitle: string;

  _fileName: string;

  _meta?: Meta;

  _stories: Record<string, Story> = {};

  _metaAnnotations: Record<string, t.Node> = {};

  _storyExports: Record<string, t.VariableDeclarator> = {};

  _storyAnnotations: Record<string, Record<string, t.Node>> = {};

  _templates: Record<string, t.Expression> = {};

  constructor(ast: t.File, { defaultTitle, fileName }: CsfOptions) {
    this._ast = ast;
    this._defaultTitle = defaultTitle;
    this._fileName = fileName;
  }

  _parseTitle(value: t.Node) {
    const node = t.isIdentifier(value)
      ? findVarInitialization(value.name, this._ast.program)
      : value;
    if (t.isStringLiteral(node)) return node.value;
    throw new Error(dedent`
      CSF: unexpected dynamic title ${formatLocation(node, this._fileName)}

      More info: https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#string-literal-titles
    `);
  }

  _parseMeta(declaration: t.ObjectExpression, program: t.Program) {
    const meta: Meta = {};
    declaration.properties.forEach((p: t.ObjectProperty) => {
      if (t.isIdentifier(p.key)) {
        this._metaAnnotations[p.key.name] = p.value;

        if (p.key.name === 'title') {
          meta.title = this._parseTitle(p.value);
        } else if (['includeStories', 'excludeStories'].includes(p.key.name)) {
          // @ts-ignore
          meta[p.key.name] = parseIncludeExclude(p.value);
        } else if (p.key.name === 'component') {
          const { code } = generate(p.value, {});
          meta.component = code;
        }
      }
    });
    this._meta = meta;
  }

  parse() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    traverse(this._ast, {
      ExportDefaultDeclaration: {
        enter({ node, parent }) {
          let metaNode: t.ObjectExpression;
          if (t.isObjectExpression(node.declaration)) {
            // export default { ... };
            metaNode = node.declaration;
          } else if (
            // export default { ... } as Meta<...>
            t.isTSAsExpression(node.declaration) &&
            t.isObjectExpression(node.declaration.expression)
          ) {
            metaNode = node.declaration.expression;
          } else if (t.isIdentifier(node.declaration) && t.isProgram(parent)) {
            const init = findVarInitialization(node.declaration.name, parent);
            if (t.isObjectExpression(init)) {
              metaNode = init;
            }
          }

          if (!self._meta && metaNode && t.isProgram(parent)) {
            self._parseMeta(metaNode, parent);
          }
        },
      },
      ExportNamedDeclaration: {
        enter({ node, parent }) {
          if (t.isVariableDeclaration(node.declaration)) {
            // export const X = ...;
            node.declaration.declarations.forEach((decl) => {
              if (t.isVariableDeclarator(decl) && t.isIdentifier(decl.id)) {
                const { name: exportName } = decl.id;
                self._storyExports[exportName] = decl;
                let name = storyNameFromExport(exportName);
                if (self._storyAnnotations[exportName]) {
                  logger.warn(
                    `Unexpected annotations for "${exportName}" before story declaration`
                  );
                } else {
                  self._storyAnnotations[exportName] = {};
                }
                let parameters;
                if (t.isObjectExpression(decl.init)) {
                  let __isArgsStory = true; // assume default render is an args story
                  // CSF3 object export
                  decl.init.properties.forEach((p: t.ObjectProperty) => {
                    if (t.isIdentifier(p.key)) {
                      if (p.key.name === 'render') {
                        __isArgsStory = isArgsStory(p.value as t.Expression, parent, self);
                      } else if (p.key.name === 'name' && t.isStringLiteral(p.value)) {
                        name = p.value.value;
                      }
                      self._storyAnnotations[exportName][p.key.name] = p.value;
                    }
                  });
                  parameters = { __isArgsStory };
                } else {
                  parameters = {
                    // __id: toId(self._meta.title, name),
                    // FIXME: Template.bind({});
                    __isArgsStory: isArgsStory(decl.init, parent, self),
                  };
                }
                self._stories[exportName] = {
                  id: 'FIXME',
                  name,
                  parameters,
                };
              }
            });
          }
        },
      },
      ExpressionStatement: {
        enter({ node, parent }) {
          const { expression } = node;
          // B.storyName = 'some string';
          if (
            t.isProgram(parent) &&
            t.isAssignmentExpression(expression) &&
            t.isMemberExpression(expression.left) &&
            t.isIdentifier(expression.left.object) &&
            t.isIdentifier(expression.left.property)
          ) {
            const exportName = expression.left.object.name;
            const annotationKey = expression.left.property.name;
            const annotationValue = expression.right;

            // v1-style annotation
            // A.story = { parameters: ..., decorators: ... }

            if (self._storyAnnotations[exportName]) {
              if (annotationKey === 'story' && t.isObjectExpression(annotationValue)) {
                annotationValue.properties.forEach((prop: t.ObjectProperty) => {
                  if (t.isIdentifier(prop.key)) {
                    self._storyAnnotations[exportName][prop.key.name] = prop.value;
                  }
                });
              } else {
                self._storyAnnotations[exportName][annotationKey] = annotationValue;
              }
            }

            if (annotationKey === 'storyName' && t.isStringLiteral(annotationValue)) {
              const storyName = annotationValue.value;
              const story = self._stories[exportName];
              if (!story) return;
              story.name = storyName;
            }
          }
        },
      },
      CallExpression: {
        enter({ node }) {
          const { callee } = node;
          if (t.isIdentifier(callee) && callee.name === 'storiesOf') {
            throw new Error(dedent`
              CSF: unexpected storiesOf call ${formatLocation(node, self._fileName)}

              More info: https://github.com/storybookjs/storybook/blob/next/MIGRATION.md#story-store-v7
            `);
          }
        },
      },
    });

    if (!self._meta) {
      throw new Error(dedent`
        CSF: missing default export ${formatLocation(self._ast, self._fileName)}

        More info: https://storybook.js.org/docs/react/writing-stories/introduction#default-export
      `);
    }

    if (!self._meta.title && !self._meta.component) {
      throw new Error(dedent`
        CSF: missing title/component ${formatLocation(self._ast, self._fileName)}

        More info: https://storybook.js.org/docs/react/writing-stories/introduction#default-export
      `);
    }

    // default export can come at any point in the file, so we do this post processing last
    const entries = Object.entries(self._stories);
    self._meta.title = self._meta.title || this._defaultTitle;
    self._stories = entries.reduce((acc, [key, story]) => {
      if (isExportStory(key, self._meta)) {
        const id = toId(self._meta.title, storyNameFromExport(key));
        const parameters: Record<string, any> = { ...story.parameters, __id: id };
        if (entries.length === 1 && key === '__page') {
          parameters.docsOnly = true;
        }
        acc[key] = { ...story, id, parameters };
      }
      return acc;
    }, {} as Record<string, Story>);

    Object.keys(self._storyExports).forEach((key) => {
      if (!isExportStory(key, self._meta)) {
        delete self._storyExports[key];
        delete self._storyAnnotations[key];
      }
    });

    return self;
  }

  public get meta() {
    return this._meta;
  }

  public get stories() {
    return Object.values(this._stories);
  }
}

export const loadCsf = (code: string, options: CsfOptions) => {
  const ast = babelParse(code);
  return new CsfFile(ast, options);
};

export const formatCsf = (csf: CsfFile) => {
  const { code } = generate(csf._ast, {});
  return code;
};

export const readCsf = async (fileName: string, options: CsfOptions) => {
  const code = (await fs.readFile(fileName, 'utf-8')).toString();
  return loadCsf(code, { ...options, fileName });
};

export const writeCsf = async (csf: CsfFile, fileName?: string) => {
  const fname = fileName || csf._fileName;
  if (!fname) throw new Error('Please specify a fileName for writeCsf');
  await fs.writeFile(fileName, await formatCsf(csf));
};
