import * as htmlparser2 from 'htmlparser2';
import * as mdast from 'mdast';
import * as definitions from 'mdast-util-definitions';
import * as remarkFrontmatter from 'remark-frontmatter';
import * as remarkParse from 'remark-parse';
import * as unified from 'unified';
import * as yaml from 'yaml';
import { ContainerCoreNode, DeepCoreNode } from '../../core/nodes';
import { BlockQuoteNode } from '../../core/nodes/BlockQuote';
import { BoldNode } from '../../core/nodes/Bold';
import { CodeBlockNode } from '../../core/nodes/CodeBlock';
import { CodeSpanNode } from '../../core/nodes/CodeSpan';
import { ContainerNode } from '../../core/nodes/Container';
import { Heading123456Node } from '../../core/nodes/Heading123456';
import { HorizontalRuleNode } from '../../core/nodes/HorizontalRule';
import { HtmlElementNode } from '../../core/nodes/HtmlElement';
import { ImageNode, ImageParameters } from '../../core/nodes/Image';
import { ItalicsNode } from '../../core/nodes/Italics';
import { LinkNode, LinkParameters } from '../../core/nodes/Link';
import { ListNode, ListType, ListTypeParameters } from '../../core/nodes/List';
import { ParagraphNode } from '../../core/nodes/Paragraph';
import { PlainTextNode } from '../../core/nodes/PlainText';
import { StrikethroughNode } from '../../core/nodes/Strikethrough';
import { TableNode, TableRow } from '../../core/nodes/Table';
import { ConcatIter, Iter } from '../../util/Iter';

const remark = unified().use(remarkParse).use(remarkFrontmatter);

export interface ParseMarkdownContext {
    container: ContainerCoreNode<DeepCoreNode>;
    nodeIter: Iter<mdast.Content>;
}

export interface ParseMarkdownOptions {
    unwrapFirstLineParagraph?: boolean;
    handleHtmlComment?: (
        context: ParseMarkdownContext,
        comment: string,
    ) => void;
}

type ParsedHtmlChunk =
    | {
          type: 'opentag';
          tagName: string;
          attributes: Record<string, string>;
      }
    | { type: 'closetag'; tagName: string }
    | { type: 'text'; text: string }
    | { type: 'comment'; comment: string };

export function parseMarkdownWithYamlFrontmatter(
    text: string,
    opt?: ParseMarkdownOptions,
): {
    frontmatter: null | { value: unknown };
    rootContainer: ContainerNode<DeepCoreNode>;
} {
    const rootNode = remark.parse(text) as mdast.Root;
    const definition = definitions(rootNode);
    const rootContainer = ContainerNode<DeepCoreNode>({});
    const context: ParseMarkdownContext = {
        container: rootContainer,
        nodeIter: Iter(rootNode.children),
    };
    let yamlFrontmatterString: string | null = null;

    const chunks: ParsedHtmlChunk[] = [];
    const htmlParser = new htmlparser2.Parser({
        onerror(error): void {
            throw error;
        },
        onopentag(tagName, attributes): void {
            chunks.push({ type: 'opentag', tagName, attributes });
        },
        onclosetag(tagName): void {
            chunks.push({ type: 'closetag', tagName });
        },
        ontext(text: string): void {
            chunks.push({ type: 'text', text });
        },
        oncomment(comment: string): void {
            chunks.push({ type: 'comment', comment });
        },
        oncdatastart(): void {
            throw new Error('Unexpected CDATA.');
        },
        onprocessinginstruction(): void {
            throw new Error('Unexpected processing instruction.');
        },
    });

    // https://github.com/syntax-tree/mdast
    function traverseNode(node: mdast.Content): void {
        switch (node.type) {
            case 'paragraph': {
                if (!node.position) {
                    throw new Error('No.');
                }
                if (
                    opt?.unwrapFirstLineParagraph &&
                    node.position.start.column === 1 &&
                    node.position.start.line === 1
                ) {
                    context.nodeIter = ConcatIter(
                        Iter(node.children),
                        context.nodeIter,
                    );
                    break;
                }
                const paragraph = ParagraphNode<DeepCoreNode>({});
                traverseChildren(paragraph, node);
                break;
            }
            case 'heading': {
                const heading123456 = Heading123456Node<DeepCoreNode>({
                    level: node.depth,
                });
                traverseChildren(heading123456, node);
                break;
            }
            case 'thematicBreak': {
                context.container.children.push(HorizontalRuleNode({}));
                break;
            }
            case 'blockquote': {
                const blockQuote = BlockQuoteNode<DeepCoreNode>({});
                traverseChildren(blockQuote, node);
                break;
            }
            case 'listItem': {
                throw new Error('Unexpected list item node.');
            }
            case 'list': {
                const listType: ListTypeParameters = node.ordered
                    ? {
                          type: ListType.Ordered,
                          start: node.start ?? undefined,
                      }
                    : {
                          type: ListType.Unordered,
                      };
                const list = ListNode<DeepCoreNode>({ listType });
                context.container.children.push(list);
                const oldContainer = context.container;
                context.container = list;
                for (const childNode of node.children) {
                    const container = ContainerNode<DeepCoreNode>({});
                    if (childNode.checked !== null) {
                        throw new Error(
                            `Unsupported list item type. ${JSON.stringify(
                                node,
                                null,
                                2,
                            )}`,
                        );
                    }
                    traverseChildren(container, childNode);
                }
                context.container = oldContainer;
                break;
            }
            case 'table': {
                // TODO: support different align types.
                if (node.align && node.align.some((item) => item !== null)) {
                    throw new Error('Unsupported table align.');
                }
                if (node.children.length === 0) {
                    throw new Error('Table has no rows.');
                }
                const header = parseTableRow(node.children[0]);
                const table = TableNode<DeepCoreNode, DeepCoreNode>({
                    header,
                    rows: node.children.slice(1).map(parseTableRow),
                });
                context.container.children.push(table);
                break;
            }
            case 'tableRow': {
                throw new Error('Unexpected table row.');
            }
            case 'tableCell': {
                throw new Error('Unexpected table cell.');
            }
            case 'html': {
                htmlParser.write(node.value);
                let _onCloseTag: ((tagName: string) => void) | undefined;

                // eslint-disable-next-line no-inner-declarations
                function onChunk(chunk: ParsedHtmlChunk): void {
                    switch (chunk.type) {
                        case 'opentag': {
                            onOpenTag(chunk.tagName, chunk.attributes);
                            break;
                        }
                        case 'closetag': {
                            if (!_onCloseTag) {
                                throw new Error(
                                    'Closing html tag with no opening tag.',
                                );
                            }
                            _onCloseTag(chunk.tagName);
                            break;
                        }
                        case 'text': {
                            context.container.children.push(
                                PlainTextNode({
                                    text: chunk.text,
                                }),
                            );
                            break;
                        }
                        case 'comment': {
                            if (opt && opt.handleHtmlComment) {
                                opt.handleHtmlComment(context, chunk.comment);
                            }
                            break;
                        }
                    }
                }

                // eslint-disable-next-line no-inner-declarations
                function onOpenTag(
                    tagName: string,
                    attributes: Record<string, string>,
                ): void {
                    const htmlElement = HtmlElementNode<DeepCoreNode>({
                        tagName,
                        attributes,
                    });
                    const oldContainer = context.container;
                    const oldNodeIter = context.nodeIter;
                    oldContainer.children.push(htmlElement);
                    context.container = htmlElement;
                    let didFindCloseTag = false;
                    const oldOnCloseTag = _onCloseTag;
                    const onCloseTag = (endTagName: string) => {
                        if (didFindCloseTag) {
                            throw new Error('Multiple close tags.');
                        }
                        if (endTagName !== tagName) {
                            throw new Error(
                                'End tag name does not equal start tag name.',
                            );
                        }
                        if (_onCloseTag !== onCloseTag) {
                            throw new Error('Unclosed tag.');
                        }
                        if (context.container !== htmlElement) {
                            throw new Error(
                                'Not in same container when parsing html tag.',
                            );
                        }
                        didFindCloseTag = true;
                    };
                    _onCloseTag = onCloseTag;
                    while (true) {
                        if (chunks.length !== 0) {
                            let chunk: ParsedHtmlChunk | undefined;
                            while ((chunk = chunks.shift())) {
                                onChunk(chunk);
                            }
                            if (didFindCloseTag) {
                                break;
                            }
                        }
                        const node = context.nodeIter.next();
                        if (!node) {
                            break;
                        }
                        if (node.type === 'html') {
                            htmlParser.write(node.value);
                        } else {
                            traverseNode(node);
                            if (didFindCloseTag) {
                                break;
                            }
                        }
                    }
                    if (!didFindCloseTag) {
                        throw new Error(
                            'Did not find corresponding close tag.',
                        );
                    }
                    context.container = oldContainer;
                    context.nodeIter = oldNodeIter;
                    _onCloseTag = oldOnCloseTag;
                }

                let chunk: ParsedHtmlChunk | undefined;
                while ((chunk = chunks.shift())) {
                    onChunk(chunk);
                }
                break;
            }
            case 'code': {
                if (node.meta !== null) {
                    throw new Error('Invalid code block.');
                }
                const codeBlock = CodeBlockNode({
                    language: node.lang,
                    code: node.value,
                });
                context.container.children.push(codeBlock);
                break;
            }
            case 'definition': {
                // Don't output.
                break;
            }
            case 'footnoteDefinition': {
                throw new Error('Footnote definitions are not supported.');
            }
            case 'text': {
                context.container.children.push(
                    PlainTextNode({ text: node.value }),
                );
                break;
            }
            case 'emphasis': {
                const italics = ItalicsNode<DeepCoreNode>({});
                traverseChildren(italics, node);
                break;
            }
            case 'strong': {
                const bold = BoldNode<DeepCoreNode>({});
                traverseChildren(bold, node);
                break;
            }
            case 'delete': {
                const strikethrough = StrikethroughNode<DeepCoreNode>({});
                traverseChildren(strikethrough, node);
                break;
            }
            case 'inlineCode': {
                const inlineCode = CodeSpanNode<PlainTextNode>({
                    children: [PlainTextNode({ text: node.value })],
                });
                context.container.children.push(inlineCode);
                break;
            }
            case 'break': {
                throw new Error(
                    'Markdown breaks are not supported. Trailing spaces representing line breaks is unpleasant.',
                );
            }
            case 'link': {
                const parameters: LinkParameters<DeepCoreNode> = {
                    destination: node.url,
                };
                if (node.title !== undefined) {
                    parameters.title = node.title;
                }
                const link = LinkNode<DeepCoreNode>(parameters);
                traverseChildren(link, node);
                break;
            }
            case 'image': {
                const parameters: ImageParameters = { src: node.url };
                if (node.title !== undefined) {
                    parameters.title = node.title;
                }
                if (node.alt !== undefined) {
                    parameters.alt = node.alt;
                }
                const image = ImageNode(parameters);
                context.container.children.push(image);
                break;
            }
            case 'linkReference': {
                const definitionNode = definition(node.identifier);
                if (!definitionNode) {
                    throw new Error(
                        `No definition found for identifier ${node.identifier}`,
                    );
                }
                const parameters: LinkParameters<DeepCoreNode> = {
                    destination: definitionNode.url,
                };
                if (definitionNode.title !== undefined) {
                    parameters.title = definitionNode.title;
                }
                const link = LinkNode<DeepCoreNode>(parameters);
                if (node.children.length > 0) {
                    traverseChildren(link, node);
                } else {
                    context.container.children.push(link);
                    link.children.push(
                        PlainTextNode({
                            text:
                                node.label ||
                                definitionNode.label ||
                                node.identifier,
                        }),
                    );
                }
                break;
            }
            case 'imageReference': {
                const definitionNode = definition(node.identifier);
                if (!definitionNode) {
                    throw new Error(
                        `No definition found for identifier ${node.identifier}`,
                    );
                }
                const parameters: ImageParameters = { src: definitionNode.url };
                if (definitionNode.title !== undefined) {
                    parameters.title = definitionNode.title;
                }
                if (node.alt !== undefined) {
                    parameters.alt = node.alt;
                }
                const image = ImageNode(parameters);
                context.container.children.push(image);
                break;
            }
            case 'footnoteReference': {
                throw new Error('Footnote references are not supported.');
            }
            case 'footnote': {
                // TODO: support footnotes.
                throw new Error('Footnotes are not supported.');
            }
            case 'yaml': {
                yamlFrontmatterString = node.value;
                break;
            }
            default: {
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-expect-error Should already implement all node types.
                // eslint-disable-next-line max-len
                // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
                console.error(`Unknown node type ${node.type}`);
                console.dir(node, { depth: null });
            }
        }
    }

    function parseTableRow(node: mdast.TableRow): TableRow<DeepCoreNode> {
        const row = TableRow<DeepCoreNode>({});
        // Loop over cells.
        for (const childNode of node.children) {
            const container = ContainerNode<DeepCoreNode>({});
            row.children.push(container);
            traverseChildren(container, childNode);
        }
        return row;
    }

    function traverseChildren(
        container: ContainerCoreNode<DeepCoreNode>,
        parent: mdast.Parent,
    ): void {
        const oldContainer = context.container;
        const oldNodeIter = context.nodeIter;
        oldContainer.children.push(container);
        context.container = container;
        context.nodeIter = Iter(parent.children);
        let node: mdast.Content | undefined;
        while ((node = context.nodeIter.next())) {
            traverseNode(node);
        }
        context.container = oldContainer;
        context.nodeIter = oldNodeIter;
    }

    let node: mdast.Content | undefined;
    while ((node = context.nodeIter.next())) {
        traverseNode(node);
    }
    return {
        frontmatter:
            yamlFrontmatterString === null
                ? null
                : {
                      value: yaml.parse(yamlFrontmatterString),
                  },
        rootContainer,
    };
}

export function parseMarkdown(
    text: string,
    opt?: ParseMarkdownOptions,
): ContainerNode<DeepCoreNode> {
    const { frontmatter, rootContainer } = parseMarkdownWithYamlFrontmatter(
        text,
        opt,
    );
    if (frontmatter !== null) {
        throw new Error('Unexpected markdown frontmatter.');
    }
    return rootContainer;
}
