/* eslint-disable max-len */
/**
 * Thanks to the api-documenter team for some ideas used in this script:
 *
 * https://github.com/microsoft/rushstack/blob/8b2edd9/apps/api-documenter/src/markdown/MarkdownEmitter.ts
 * https://github.com/microsoft/rushstack/blob/a30cdf5/apps/api-extractor-model/src/model/ApiModel.ts
 *
 * The api-documenter project is licensed under MIT, and its license can be found at <rootDir>/vendor/licenses/@microsoft/api-documenter/LICENSE
 * The api-extractor-model project is licensed under MIT, and its license can be found at <rootDir>/vendor/licenses/@microsoft/api-extractor-model/LICENSE
 */
/* eslint-enable max-len */

import * as aeModel from '@microsoft/api-extractor-model';
import * as tsdoc from '@microsoft/tsdoc';
import { DeclarationReference } from '@microsoft/tsdoc/lib/beta/DeclarationReference';
import * as colors from 'colors';
import * as ts from 'typescript';
import * as uuid from 'uuid';
import { BlockQuoteNode } from './nodes/BlockQuote';
import { CodeBlockNode } from './nodes/CodeBlock';
import { CodeSpanNode } from './nodes/CodeSpan';
import { ContainerNode, ContainerBase } from './nodes/Container';
import { GithubSourceLinkNode } from './nodes/GithubSourceLink';
import { HtmlElementNode } from './nodes/HtmlElement';
import { CoreNode, Node, DeepCoreNode, CoreNodeType } from './nodes/index';
import { LinkNode } from './nodes/Link';
import { ListNode, ListType } from './nodes/List';
import { LocalPageLinkNode } from './nodes/LocalPageLink';
import { ParagraphNode } from './nodes/Paragraph';
import { PlainTextNode } from './nodes/PlainText';
import { RichCodeBlockNode } from './nodes/RichCodeBlock';
import { SubheadingNode } from './nodes/Subheading';
import { TableNode, TableRow } from './nodes/Table';
import { TitleNode } from './nodes/Title';
import { parseMarkdown } from './nodes/util/parseMarkdown';
import { outDir, getMainPathOfApiItemName } from './paths';
import { SourceMetadata } from './sourceMetadata';
import { Iter } from './util/Iter';
import { format, Language } from './util/prettier';
import { StringBuilder } from './util/StringBuilder';

/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

export interface Context {
    sourceMetadata: SourceMetadata;
    apiModel: aeModel.ApiModel;
    apiItemsByMemberName: Map<string, aeModel.ApiItem[]>;
    apiItemsByCanonicalReference?: Map<string, aeModel.ApiItem>;
}

const seeTag = new tsdoc.TSDocTagDefinition({
    tagName: '@see',
    syntaxKind: tsdoc.TSDocTagSyntaxKind.BlockTag,
});

aeModel.AedocDefinitions.tsdocConfiguration.addTagDefinition(seeTag);

export class UnsupportedApiItemError extends Error {
    constructor(apiItem: aeModel.ApiItem, reason: string) {
        super();
        this.name = 'UnsupportedApiItemError';
        this.message = `The following api item ${
            apiItem.displayName
        } with package scoped name ${apiItem.getScopedNameWithinPackage()} and kind ${
            apiItem.kind
        } is not supported: ${reason}`;
    }
}

function getDocComment(apiItem: aeModel.ApiItem): tsdoc.DocComment {
    if (!(apiItem instanceof aeModel.ApiDocumentedItem)) {
        throw new UnsupportedApiItemError(apiItem, 'Not documented.');
    }

    if (!apiItem.tsdocComment) {
        throw new UnsupportedApiItemError(apiItem, 'No docComment property.');
    }

    return apiItem.tsdocComment;
}

function getBlocksOfTag(
    blocks: readonly tsdoc.DocBlock[],
    tag: tsdoc.TSDocTagDefinition,
): tsdoc.DocBlock[] {
    return blocks.filter(
        (block) =>
            block.blockTag.tagNameWithUpperCase === tag.tagNameWithUpperCase,
    );
}

function getExampleBlocks(docComment: tsdoc.DocComment): tsdoc.DocBlock[] {
    return getBlocksOfTag(docComment.customBlocks, tsdoc.StandardTags.example);
}

function getSeeBlocks(docComment: tsdoc.DocComment): tsdoc.DocBlock[] {
    return getBlocksOfTag(docComment.customBlocks, seeTag);
}

export function getApiItemName(
    apiItem: import('@microsoft/api-extractor-model').ApiItem,
): string {
    const match = /^(.+)_\d+$/.exec(apiItem.displayName);
    if (match) {
        return match[1];
    }
    return apiItem.displayName;
}

interface TSDocNodeWriteContext {
    context: Context;
    container: ContainerBase<MarkdownParsingNode>;
    embeddedNodeContext: EmbeddedNodeContext;
    nodeIter: Iter<tsdoc.DocNode>;
    htmlTagStack: HtmlElementNode<MarkdownParsingNode>[];
    apiItem: aeModel.ApiItem;
}

function writeApiItemDocNode(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiItem,
    docNode: tsdoc.DocNode,
    context: Context,
): void {
    const nodeIter = Iter([docNode]);
    nodeIter.next();
    const container_ = ContainerNode<MarkdownParsingNode>({});
    const embeddedNodeContext = new EmbeddedNodeContext();
    const context_ = {
        context,
        container: container_,
        nodeIter,
        htmlTagStack: [],
        embeddedNodeContext,
        apiItem,
    };
    writeNode(docNode, context_);
    if (container_.children.length > 0) {
        const embeddedNode = EmbeddedNode({
            originalNode: container_,
            context: embeddedNodeContext,
        });
        substituteEmbeddedNodes(embeddedNode, embeddedNodeContext);
        container.children.push(
            (container_ as unknown) as ContainerNode<DeepCoreNode>,
        );
    }
}

class EmbeddedNodeContext {
    private _n = 0;
    private _idMap = new Map<number, () => EmbeddedNode>();
    private _baseId = uuid.v4();
    private _embeddedNodeRegexp = RegExp(
        `^__EmbeddedNode-${this._baseId}__:(\\d+)$`,
    );

    public generateMarker(getNode: () => EmbeddedNode): string {
        const id = this._n++;
        this._idMap.set(id, getNode);
        return `<!--__EmbeddedNode-${this._baseId}__:${id}-->`;
    }

    public extractNodeFromComment(comment: string): EmbeddedNode | void {
        const match = this._embeddedNodeRegexp.exec(comment);
        if (match) {
            const id = Number.parseInt(match[1]);
            return this._getNodeForId(id);
        }
    }

    private _getNodeForId(id: number): EmbeddedNode {
        const getNode = this._idMap.get(id);
        if (!getNode) {
            throw new Error('No node defined for given id.');
        }
        return getNode();
    }
}

enum MarkdownParsingNodeType {
    EmbeddedNode = 'EmbeddedNode',
    RawText = 'RawText',
}

interface EmbeddedNode extends Node {
    type: MarkdownParsingNodeType.EmbeddedNode;
    originalNode: CoreNode<MarkdownParsingNode>;
    marker: string;
}

interface EmbeddedNodeParameters {
    originalNode: CoreNode<MarkdownParsingNode>;
    context: EmbeddedNodeContext;
}

function EmbeddedNode(parameters: EmbeddedNodeParameters): EmbeddedNode {
    if (parameters.originalNode instanceof EmbeddedNode) {
        throw new Error(
            'EmbeddedNode node argument cannot be an EmbeddedNode.',
        );
    }
    const embeddedNode: EmbeddedNode = {
        type: MarkdownParsingNodeType.EmbeddedNode,
        originalNode: parameters.originalNode,
        marker: parameters.context.generateMarker(() => embeddedNode),
    };
    return embeddedNode;
}

interface RawText extends Node {
    type: MarkdownParsingNodeType.RawText;
    text: string;
}

interface RawTextParameters {
    text: string;
}

function RawText(parameters: RawTextParameters): RawText {
    return {
        type: MarkdownParsingNodeType.RawText,
        text: parameters.text,
    };
}

type MarkdownParsingNode = EmbeddedNode | RawText;

function writeMarkdownParsingNode(
    node: EmbeddedNode | RawText,
    output: StringBuilder,
): void {
    if (node.type === MarkdownParsingNodeType.EmbeddedNode) {
        output.write(node.marker);
    } else {
        output.write(node.text);
    }
}

function substituteEmbeddedNodes(
    embeddedNode: EmbeddedNode,
    context: EmbeddedNodeContext,
): void {
    if (!('children' in embeddedNode.originalNode)) {
        return;
    }

    const output = new StringBuilder();
    for (const node of embeddedNode.originalNode.children) {
        writeMarkdownParsingNode(node, output);
    }
    const markdown = output.toString();

    const markdownContainer = parseMarkdown(markdown, {
        unwrapFirstLineParagraph: true,
    });

    _substituteEmbeddedNodes(embeddedNode, context, markdownContainer);
    // TODO: fix.
    ((embeddedNode.originalNode as unknown) as ContainerBase<
        DeepCoreNode
    >).children = markdownContainer.children;
}

function _substituteEmbeddedNodes(
    embeddedNode: EmbeddedNode,
    context: EmbeddedNodeContext,
    node: ContainerBase<DeepCoreNode>,
): void {
    for (const [i, child] of node.children.entries()) {
        if ('children' in child) {
            _substituteEmbeddedNodes(embeddedNode, context, child);
        } else if (child.type === CoreNodeType.HtmlComment) {
            const embeddedNode = context.extractNodeFromComment(child.comment);
            if (embeddedNode) {
                substituteEmbeddedNodes(embeddedNode, context);
                node.children[i] = embeddedNode.originalNode as DeepCoreNode;
            }
        }
    }
}

function writeNode(
    docNode: tsdoc.DocNode,
    context: TSDocNodeWriteContext,
): void {
    const { container } = context;

    switch (docNode.kind) {
        case tsdoc.DocNodeKind.PlainText: {
            const docPlainText = docNode as tsdoc.DocPlainText;
            const textNode = RawText({ text: docPlainText.text });
            container.children.push(textNode);
            let node: tsdoc.DocNode | undefined;
            let foundSoftBreak = false;
            while ((node = context.nodeIter.peekNext())) {
                if (node.kind === tsdoc.DocNodeKind.SoftBreak) {
                    foundSoftBreak = true;
                    context.nodeIter.next();
                } else {
                    break;
                }
            }
            if (foundSoftBreak) {
                textNode.text += ' ';
            }
            break;
        }
        case tsdoc.DocNodeKind.HtmlStartTag: {
            const docStartTag = docNode as tsdoc.DocHtmlStartTag;
            const oldContainer = container;
            const htmlElement = HtmlElementNode<MarkdownParsingNode>({
                tagName: docStartTag.name,
            });
            oldContainer.children.push(
                EmbeddedNode({
                    originalNode: htmlElement,
                    context: context.embeddedNodeContext,
                }),
            );
            context.container = htmlElement;
            context.htmlTagStack.push(htmlElement);
            let node: tsdoc.DocNode | undefined;
            let didFindEndTag = false;
            while ((node = context.nodeIter.next())) {
                if (node.kind === tsdoc.DocNodeKind.HtmlEndTag) {
                    const docEndTag = node as tsdoc.DocHtmlEndTag;
                    if (
                        context.htmlTagStack[
                            context.htmlTagStack.length - 1
                        ] !== htmlElement
                    ) {
                        throw new Error('Unclosed tag.');
                    }
                    if (docEndTag.kind !== htmlElement.tagName) {
                        throw new Error(
                            'End html tag name not equal to start tag name.',
                        );
                    }
                    context.container = oldContainer;
                    didFindEndTag = true;
                    break;
                }
                writeNode(docNode, context);
            }
            if (!didFindEndTag) {
                throw new Error('Did not find corresponding end tag.');
            }
            break;
        }
        case tsdoc.DocNodeKind.HtmlEndTag: {
            throw new Error('Unexpected end tag.');
        }
        case tsdoc.DocNodeKind.CodeSpan: {
            const docCodeSpan = docNode as tsdoc.DocCodeSpan;
            container.children.push(
                EmbeddedNode({
                    originalNode: CodeSpanNode<MarkdownParsingNode>({
                        children: [
                            EmbeddedNode({
                                originalNode: PlainTextNode({
                                    text: docCodeSpan.code,
                                }),
                                context: context.embeddedNodeContext,
                            }),
                        ],
                    }),
                    context: context.embeddedNodeContext,
                }),
            );
            break;
        }
        case tsdoc.DocNodeKind.LinkTag: {
            const docLinkTag = docNode as tsdoc.DocLinkTag;
            if (docLinkTag.codeDestination) {
                writeLinkTagWithCodeDestination(docLinkTag, context);
            } else if (docLinkTag.urlDestination) {
                writeLinkTagWithUrlDestination(docLinkTag, context);
            } else if (docLinkTag.linkText) {
                container.children.push(
                    EmbeddedNode({
                        originalNode: PlainTextNode({
                            text: docLinkTag.linkText,
                        }),
                        context: context.embeddedNodeContext,
                    }),
                );
            }
            break;
        }
        case tsdoc.DocNodeKind.Paragraph: {
            const docParagraph = docNode as tsdoc.DocParagraph;
            // eslint-disable-next-line max-len
            const trimmedParagraph = tsdoc.DocNodeTransforms.trimSpacesInParagraph(
                docParagraph,
            );
            const oldContainer = container;
            const paragraph = ParagraphNode<MarkdownParsingNode>({});
            context.container = paragraph;
            for (const node of trimmedParagraph.nodes) {
                writeNode(node, context);
            }
            if (paragraph.children.length > 0) {
                oldContainer.children.push(
                    EmbeddedNode({
                        originalNode: paragraph,
                        context: context.embeddedNodeContext,
                    }),
                );
            }
            context.container = oldContainer;
            break;
        }
        case tsdoc.DocNodeKind.FencedCode: {
            const docFencedCode = docNode as tsdoc.DocFencedCode;
            container.children.push(
                EmbeddedNode({
                    originalNode: CodeBlockNode({
                        language: docFencedCode.language,
                        code: docFencedCode.code,
                    }),
                    context: context.embeddedNodeContext,
                }),
            );
            break;
        }
        case tsdoc.DocNodeKind.Section: {
            const docSection = docNode as tsdoc.DocSection;
            for (const node of docSection.nodes) {
                writeNode(node, context);
            }
            break;
        }
        case tsdoc.DocNodeKind.SoftBreak: {
            // TODO: RawText?
            container.children.push(
                EmbeddedNode({
                    originalNode: PlainTextNode({ text: ' ' }),
                    context: context.embeddedNodeContext,
                }),
            );
            break;
        }
        case tsdoc.DocNodeKind.EscapedText: {
            const docEscapedText = docNode as tsdoc.DocEscapedText;
            container.children.push(
                EmbeddedNode({
                    originalNode: PlainTextNode({
                        text: docEscapedText.decodedText,
                    }),
                    context: context.embeddedNodeContext,
                }),
            );
            break;
        }
        case tsdoc.DocNodeKind.ErrorText: {
            const docErrorText = docNode as tsdoc.DocErrorText;
            container.children.push(
                EmbeddedNode({
                    originalNode: PlainTextNode({ text: docErrorText.text }),
                    context: context.embeddedNodeContext,
                }),
            );
            break;
        }
        case tsdoc.DocNodeKind.InlineTag: {
            break;
        }
        case tsdoc.DocNodeKind.BlockTag: {
            const tagNode = docNode as tsdoc.DocBlockTag;
            if (tagNode.tagName !== '@see' && tagNode.tagName !== '@example') {
                console.warn(`Unsupported block tag: ${tagNode.tagName}`);
            }
            break;
        }
        default:
            throw new Error(`Unsupported DocNodeKind kind: ${docNode.kind}`);
    }
}

function writeLinkTagWithCodeDestination(
    docLinkTag: tsdoc.DocLinkTag,
    context: TSDocNodeWriteContext,
): void {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const codeDestination = docLinkTag.codeDestination!;
    const childNodes = codeDestination.getChildNodes();
    if (childNodes.length !== 1) {
        throw new Error('No.');
    }
    const childNode = childNodes[0] as tsdoc.DocMemberReference;
    if (childNode.kind !== tsdoc.DocNodeKind.MemberReference) {
        throw new Error('No.');
    }
    const identifier = childNode.memberIdentifier?.identifier;
    if (!identifier) {
        throw new Error('No.');
    }
    const codeSpan = HtmlElementNode<MarkdownParsingNode>({ tagName: 'code' });
    context.container.children.push(
        EmbeddedNode({
            originalNode: codeSpan,
            context: context.embeddedNodeContext,
        }),
    );
    const destination = getLinkToApiItemName(
        getApiItemName(context.apiItem),
        identifier,
    );
    codeSpan.children.push(
        EmbeddedNode({
            originalNode: LocalPageLinkNode<EmbeddedNode>({
                destination,
                children: [
                    EmbeddedNode({
                        originalNode: PlainTextNode({
                            text:
                                docLinkTag.linkText !== undefined
                                    ? docLinkTag.linkText
                                    : identifier,
                        }),
                        context: context.embeddedNodeContext,
                    }),
                ],
            }),
            context: context.embeddedNodeContext,
        }),
    );
}

function writeLinkTagWithUrlDestination(
    docLinkTag: tsdoc.DocLinkTag,
    context: TSDocNodeWriteContext,
): void {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const urlDestination = docLinkTag.urlDestination!;
    const linkText =
        docLinkTag.linkText !== undefined
            ? docLinkTag.linkText
            : urlDestination;

    context.container.children.push(
        EmbeddedNode({
            originalNode: LinkNode<EmbeddedNode>({
                destination: urlDestination,
                children: [
                    EmbeddedNode({
                        originalNode: PlainTextNode({
                            text: linkText.replace(/\s+/g, ' '),
                        }),
                        context: context.embeddedNodeContext,
                    }),
                ],
            }),
            context: context.embeddedNodeContext,
        }),
    );
}

function getRelativePath(from: string, to: string): string {
    if (from === to) {
        return '';
    }
    const fromSplit = from.split(/[/\\]/g);
    fromSplit.pop();
    const toSplit = to.split(/[/\\]/g);
    const name = toSplit.pop();
    if (!name) {
        throw new Error('No.');
    }
    let i = 0;
    for (; i < fromSplit.length && i < toSplit.length; i++) {
        if (fromSplit[i] !== toSplit[i]) {
            break;
        }
    }
    const start =
        '../'.repeat(fromSplit.length - i) + toSplit.slice(i).join('/');
    return start === ''
        ? name
        : start + (start.endsWith('/') ? '' : '/') + name;
}

function getLinkToApiItemName(
    currentApiItemName: string,
    apiItemName: string,
): string {
    const currentApiItemPath = getMainPathOfApiItemName(currentApiItemName);
    const apiItemPath = getMainPathOfApiItemName(apiItemName);
    if (!currentApiItemPath || !apiItemPath) {
        throw new Error('No more coding today.');
    }
    const relativePath = getRelativePath(currentApiItemPath, apiItemPath);
    const titleHash = apiItemName.toLowerCase();

    return relativePath ? `${relativePath}#${titleHash}` : `#${titleHash}`;
}

function getLinkToApiItem(
    currentApiItemName: string,
    apiItem: aeModel.ApiItem,
    context: Context,
): string {
    const currentApiItemPath = getMainPathOfApiItemName(currentApiItemName);
    const apiItemPath = getMainPathOfApiItemName(getApiItemName(apiItem));
    if (!currentApiItemPath || !apiItemPath) {
        throw new Error('No more coding today.');
    }
    const relativePath = getRelativePath(currentApiItemPath, apiItemPath);
    const titleHash = getApiItemAnchorName(apiItem, context);

    return relativePath ? `${relativePath}#${titleHash}` : `#${titleHash}`;
}

function isDocSectionEmpty(docComment: tsdoc.DocNode): boolean {
    if (docComment.getChildNodes().length === 0) {
        return true;
    }
    if (docComment.getChildNodes().length > 1) {
        return false;
    }
    const firstNode = docComment.getChildNodes()[0];
    if (firstNode.kind !== tsdoc.DocNodeKind.Paragraph) {
        return false;
    }
    const paragraphChildren = firstNode.getChildNodes();
    if (paragraphChildren.length > 1) {
        return false;
    }
    return (
        paragraphChildren.length === 1 &&
        paragraphChildren[0].kind === tsdoc.DocNodeKind.SoftBreak
    );
}

export function writeSummary(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiItem,
    context: Context,
    docComment = getDocComment(apiItem),
): boolean {
    const summarySection = docComment.summarySection;
    const isEmpty = isDocSectionEmpty(summarySection);
    if (isEmpty) {
        return false;
    }
    writeApiItemDocNode(container, apiItem, summarySection, context);
    return true;
}

export function writeExamples(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiItem,
    context: Context,
    docComment = getDocComment(apiItem),
): boolean {
    let didWrite = false;
    for (const exampleBlock of getExampleBlocks(docComment)) {
        container.children.push(
            TitleNode({
                children: [PlainTextNode({ text: 'Example Usage' })],
            }),
        );
        for (const block of exampleBlock.getChildNodes()) {
            writeApiItemDocNode(container, apiItem, block, context);
        }
        didWrite = true;
    }
    return didWrite;
}

function areMultipleKindsInApiItemList(apiItems: aeModel.ApiItem[]): boolean {
    const kind = apiItems[0].kind;
    return apiItems.some((apiItem_) => apiItem_.kind !== kind);
}

function hasMultipleKinds(apiItem: aeModel.ApiItem, context: Context): boolean {
    return areMultipleKindsInApiItemList(
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        context.apiItemsByMemberName.get(getApiItemName(apiItem))!,
    );
}

export function getMultiKindApiItemAnchorNameFromNameAndKind(
    name: string,
    kind: string,
): string {
    return `${name}-${kind}`.toLowerCase().replace(/ /g, '');
}

function getMultiKindApiItemAnchorName(apiItem: aeModel.ApiItem): string {
    return getMultiKindApiItemAnchorNameFromNameAndKind(
        getApiItemName(apiItem),
        apiItem.kind,
    );
}

function getApiItemAnchorName(
    apiItem: aeModel.ApiItem,
    context: Context,
): string {
    if (hasMultipleKinds(apiItem, context)) {
        return getMultiKindApiItemAnchorName(apiItem);
    }
    return getApiItemName(apiItem).toLowerCase();
}

export function writeApiItemAnchor(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiItem,
    context: Context,
    textKind: string,
): void {
    if (hasMultipleKinds(apiItem, context)) {
        container.children.push(
            SubheadingNode({
                alternateId: getMultiKindApiItemAnchorName(apiItem),
                children: [
                    CodeSpanNode({
                        children: [
                            PlainTextNode({
                                text: `${getApiItemName(
                                    apiItem,
                                )} - ${textKind}`,
                            }),
                        ],
                    }),
                ],
            }),
        );
    }
}

export function writeBaseDoc(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiItem,
    context: Context,
    kind: ts.SyntaxKind,
): void {
    // eslint-disable-next-line max-len
    const exportNameMetadata = context.sourceMetadata.syntaxKindToExportNameMetadata.get(
        kind,
    );
    if (!exportNameMetadata) {
        throw new Error(`No export name metadata for kind ${kind}.`);
    }

    const baseDocComment = exportNameMetadata.exportNameToBaseDocComment.get(
        getApiItemName(apiItem),
    );
    if (!baseDocComment) {
        return;
    }

    const tsdocParser = new tsdoc.TSDocParser(
        aeModel.AedocDefinitions.tsdocConfiguration,
    );
    const parserContext = tsdocParser.parseRange(baseDocComment.textRange);
    const docComment = parserContext.docComment;

    const errorMessages = parserContext.log.messages.filter(
        (message) => !message.toString().includes('@see'),
    );

    if (errorMessages.length !== 0) {
        console.log(colors.red('Errors parsing TSDoc comment.'));
        console.log(
            colors.red(
                baseDocComment.textRange.buffer.slice(
                    baseDocComment.textRange.pos,
                    baseDocComment.textRange.end,
                ),
            ),
        );
        for (const message of errorMessages) {
            console.log(colors.red(message.toString()));
        }
    }

    writeSummary(container, apiItem, context, docComment);
    writeReturnsBlockWithoutType(container, apiItem, context, docComment);
    writeExamples(container, apiItem, context, docComment);
    writeSeeBlocks(container, apiItem, context, docComment);
}

function writeReturnsBlockWithoutType(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiItem,
    context: Context,
    docComment: tsdoc.DocComment,
): void {
    if (!docComment.returnsBlock) {
        return;
    }

    container.children.push(
        TitleNode({
            children: [PlainTextNode({ text: 'Returns' })],
        }),
    );
    for (const node of docComment.returnsBlock.content.nodes) {
        writeApiItemDocNode(container, apiItem, node, context);
    }
}

export function writeSignatureExcerpt(
    container: ContainerBase<DeepCoreNode>,
    apiItem:
        | aeModel.ApiFunction
        | aeModel.ApiInterface
        | aeModel.ApiVariable
        | aeModel.ApiTypeAlias,
    context: Context,
) {
    writeApiItemExcerpt(container, apiItem, apiItem.excerpt, context);
}

export function writeSignature(
    container: ContainerBase<DeepCoreNode>,
    apiItem:
        | aeModel.ApiFunction
        | aeModel.ApiInterface
        | aeModel.ApiVariable
        | aeModel.ApiTypeAlias,
    context: Context,
): void {
    container.children.push(
        TitleNode({
            children: [PlainTextNode({ text: 'Signature' })],
        }),
    );
    writeSignatureExcerpt(container, apiItem, context);
}

export function writeSeeBlocks(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiItem,
    context: Context,
    docComment = getDocComment(apiItem),
): boolean {
    const list = ListNode<DeepCoreNode>({
        listType: {
            type: ListType.Unordered,
        },
    });
    for (const seeBlock of getSeeBlocks(docComment)) {
        const listItem = ContainerNode<DeepCoreNode>({});
        list.children.push(listItem);
        for (const block of seeBlock.getChildNodes()) {
            writeApiItemDocNode(listItem, apiItem, block, context);
        }
    }
    if (list.children.length > 0) {
        container.children.push(
            TitleNode({
                children: [PlainTextNode({ text: 'See Also' })],
            }),
        );
        container.children.push(list);
        return true;
    }
    return false;
}

export function writeSourceLocation(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiItem,
    context: Context,
    kind: ts.SyntaxKind,
): void {
    // eslint-disable-next-line max-len
    const exportNameMetadata = context.sourceMetadata.syntaxKindToExportNameMetadata.get(
        kind,
    );
    if (!exportNameMetadata) {
        throw new Error(`No export name metadata for kind ${kind}.`);
    }

    const apiItemName = getApiItemName(apiItem);
    const sourceLocation = exportNameMetadata.exportNameToSourceLocation.get(
        apiItemName,
    );
    if (!sourceLocation) {
        // This should never be reached.
        throw new UnsupportedApiItemError(apiItem, 'No source location.');
    }

    const currentApiItemPath = `${outDir}/${getMainPathOfApiItemName(
        apiItemName,
    )}`;
    const sourceGithubPath = `${sourceLocation.filePath}#L${sourceLocation.lineNumber}`;
    const relativePath = getRelativePath(currentApiItemPath, sourceGithubPath);

    container.children.push(
        BlockQuoteNode({
            children: [
                PlainTextNode({ text: 'Source Location: ' }),
                GithubSourceLinkNode({
                    destination: relativePath,
                    children: [PlainTextNode({ text: sourceGithubPath })],
                }),
            ],
        }),
    );
}

function createNodeForTypeExcerpt(
    excerpt: aeModel.Excerpt,
    apiItem: aeModel.ApiItem,
    context: Context,
): DeepCoreNode {
    if (!excerpt.text.trim()) {
        return PlainTextNode({ text: '(not declared)' });
    }

    const richCodeBlock = RichCodeBlockNode<DeepCoreNode>({
        language: 'ts',
    });

    const spannedTokens = excerpt.spannedTokens.slice();
    let token: aeModel.ExcerptToken | undefined;
    let isOnlyText = true;

    while ((token = spannedTokens.shift())) {
        const tokenText = token.text;
        const result = getExcerptTokenReference(
            token,
            tokenText,
            excerpt.text,
            context,
        );

        if (result === null) {
            richCodeBlock.children.push(PlainTextNode({ text: tokenText }));
        } else if (
            result.type === FoundExcerptTokenReferenceResultType.Export
        ) {
            isOnlyText = false;
            richCodeBlock.children.push(
                LocalPageLinkNode({
                    destination: getLinkToApiItem(
                        getApiItemName(apiItem),
                        result.apiItem,
                        context,
                    ),
                    children: [PlainTextNode({ text: tokenText })],
                }),
            );
        } else {
            // Local signature reference.
            spannedTokens.unshift(...result.tokens);
        }
    }

    if (isOnlyText) {
        let formattedText: string;
        try {
            formattedText = format(
                `type X = ${excerpt.text}`,
                Language.TypeScript,
            )
                .replace(/^type X =/, '')
                .trim();
        } catch (error) {
            console.error(error);
            formattedText = excerpt.text;
        }
        return CodeBlockNode({
            language: 'ts',
            code: formattedText,
        });
    }

    return richCodeBlock;
}

export function writeParameters(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiFunction,
    context: Context,
): boolean {
    let didWrite = false;
    const parametersTable = TableNode<DeepCoreNode, DeepCoreNode>({
        header: TableRow({
            children: [
                PlainTextNode({ text: 'Parameter' }),
                PlainTextNode({ text: 'Type' }),
                PlainTextNode({ text: 'Description' }),
            ],
        }),
    });

    if (apiItem.parameters.some((param) => param.tsdocParamBlock)) {
        for (const apiParameter of apiItem.parameters) {
            const parameterRow = TableRow<DeepCoreNode>({
                children: [
                    PlainTextNode({ text: apiParameter.name }),
                    createNodeForTypeExcerpt(
                        apiParameter.parameterTypeExcerpt,
                        apiItem,
                        context,
                    ),
                ],
            });

            const cell = ContainerNode<DeepCoreNode>({});
            parameterRow.children.push(cell);
            if (apiParameter.tsdocParamBlock) {
                for (const node of apiParameter.tsdocParamBlock.content.nodes) {
                    writeApiItemDocNode(cell, apiItem, node, context);
                }
            }

            parametersTable.rows.push(parameterRow);
        }
    }

    if (parametersTable.rows.length > 0) {
        container.children.push(
            TitleNode({
                children: [PlainTextNode({ text: 'Parameters' })],
            }),
        );
        container.children.push(parametersTable);
        didWrite = true;
    }

    const docComment = getDocComment(apiItem);
    if (
        aeModel.ApiReturnTypeMixin.isBaseClassOf(apiItem) &&
        docComment.returnsBlock
    ) {
        const returnsRow = TableRow<DeepCoreNode>({
            children: [
                createNodeForTypeExcerpt(
                    apiItem.returnTypeExcerpt,
                    apiItem,
                    context,
                ),
            ],
        });

        const cell = ContainerNode<DeepCoreNode>({});
        returnsRow.children.push(cell);
        for (const node of docComment.returnsBlock.content.nodes) {
            writeApiItemDocNode(cell, apiItem, node, context);
        }

        container.children.push(
            TitleNode({
                children: [PlainTextNode({ text: 'Returns' })],
            }),
        );

        container.children.push(
            TableNode<DeepCoreNode, DeepCoreNode>({
                header: TableRow({
                    children: [
                        PlainTextNode({ text: 'Type' }),
                        PlainTextNode({ text: 'Description' }),
                    ],
                }),
                rows: [returnsRow],
            }),
        );
        didWrite = true;
    }

    return didWrite;
}

// This is needed because api-extractor-model ships with its own tsdoc
// version in its node_modules folder, so the instanceof check doesn't work.
// Therefore we have to re-implement it here.
function resolveDeclarationReference(
    declarationReference: tsdoc.DocDeclarationReference | DeclarationReference,
    contextApiItem: aeModel.ApiItem | undefined,
    context: Context,
): aeModel.IResolveDeclarationReferenceResult {
    if (declarationReference instanceof DeclarationReference) {
        // Build the lookup on demand
        if (!context.apiItemsByCanonicalReference) {
            context.apiItemsByCanonicalReference = new Map<
                string,
                aeModel.ApiItem
            >();

            for (const apiPackage of context.apiModel.packages) {
                initApiItemsRecursive(apiPackage, context);
            }
        }

        const result: aeModel.IResolveDeclarationReferenceResult = {
            resolvedApiItem: undefined,
            errorMessage: undefined,
        };

        const apiItem:
            | aeModel.ApiItem
            | undefined = context.apiItemsByCanonicalReference.get(
            declarationReference.toString(),
        );

        if (!apiItem) {
            result.errorMessage = `${declarationReference.toString()} can not be located`;
        } else {
            result.resolvedApiItem = apiItem;
        }

        return result;
    }

    return context.apiModel.resolveDeclarationReference(
        declarationReference,
        contextApiItem,
    );
}

function initApiItemsRecursive(
    apiItem: aeModel.ApiItem,
    context: Context,
): void {
    if (apiItem.canonicalReference && !apiItem.canonicalReference.isEmpty) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        context.apiItemsByCanonicalReference!.set(
            apiItem.canonicalReference.toString(),
            apiItem,
        );
    }

    // Recurse container members
    if (aeModel.ApiItemContainerMixin.isBaseClassOf(apiItem)) {
        for (const apiMember of apiItem.members) {
            initApiItemsRecursive(apiMember, context);
        }
    }
}

const enum FoundExcerptTokenReferenceResultType {
    Export,
    LocalSignatureTokens,
}

interface FoundApiItemReference {
    type: FoundExcerptTokenReferenceResultType.Export;
    apiItem: aeModel.ApiItem;
}

interface FoundLocalSignatureReference {
    type: FoundExcerptTokenReferenceResultType.LocalSignatureTokens;
    tokens: aeModel.ExcerptToken[];
}

function findLocalReferenceTokens(
    canonicalReference: DeclarationReference,
    context: Context,
): FoundLocalSignatureReference {
    context;
    console.log(canonicalReference.toString());
    return (null as unknown) as FoundLocalSignatureReference;
}

function getExcerptTokenReference(
    token: aeModel.ExcerptToken,
    debugTokenText: string,
    debugExcerptText: string,
    context: Context,
): FoundApiItemReference | FoundLocalSignatureReference | null {
    if (
        token.kind !== aeModel.ExcerptTokenKind.Reference ||
        !token.canonicalReference ||
        // Non-module reference.
        token.canonicalReference.toString().startsWith('!')
    ) {
        return null;
    }
    if (token.canonicalReference.toString().includes('!~')) {
        if (token.canonicalReference.toString().endsWith('!~value')) {
            // I don't know why this is a thing.
            return null;
        }
        // Local reference.
        return findLocalReferenceTokens(token.canonicalReference, context);
    }
    // Should be a exported reference now.
    let canonicalReference = token.canonicalReference;
    if (canonicalReference.toString().endsWith(':function')) {
        // Requires (overloadIndex) at the end if a function.
        canonicalReference = canonicalReference.withOverloadIndex(1);
    }
    // if (canonicalReference.toString().includes('!Event')) {
    //     // Event type shadows the global type so api-extractor replaces it
    //     // with Event_2, but doesn't bother changing the references to
    //     // the updated name.
    //     canonicalReference = DeclarationReference.parse(
    //         canonicalReference.toString().replace('!Event', '!Event_2'),
    //     );
    // }
    const result = resolveDeclarationReference(
        canonicalReference,
        undefined,
        context,
    );

    if (result.errorMessage) {
        console.log(
            `Error resolving excerpt token ${colors.underline.bold(
                debugTokenText,
            )} reference: ${colors.red(
                result.errorMessage,
            )}. The original signature is ${colors.underline.bold(
                debugExcerptText,
            )}`,
        );
    }

    if (result.resolvedApiItem) {
        return {
            type: FoundExcerptTokenReferenceResultType.Export,
            apiItem: result.resolvedApiItem,
        };
    }

    return null;
}

function removeExportDeclare(tokenText: string): string {
    return tokenText.replace(/^export (declare )?/, '');
}

function writeApiItemExcerpt(
    container: ContainerBase<DeepCoreNode>,
    apiItem: aeModel.ApiItem,
    excerpt: aeModel.Excerpt,
    context: Context,
): void {
    if (!excerpt.text.trim()) {
        throw new Error(`Received excerpt with no declaration.`);
    }

    const richCodeBlock = RichCodeBlockNode<DeepCoreNode>({ language: 'ts' });

    if (apiItem.kind === aeModel.ApiItemKind.Variable) {
        richCodeBlock.children.push(PlainTextNode({ text: 'var ' }));
    }

    const spannedTokens = excerpt.spannedTokens.slice();
    let token: aeModel.ExcerptToken | undefined;
    let isOnlyText = true;

    while ((token = spannedTokens.shift())) {
        let tokenText = token.text;
        if (token === excerpt.spannedTokens[0]) {
            tokenText = removeExportDeclare(tokenText);
        }
        const result = getExcerptTokenReference(
            token,
            tokenText,
            excerpt.text,
            context,
        );
        if (result === null) {
            richCodeBlock.children.push(PlainTextNode({ text: tokenText }));
        } else if (
            result.type === FoundExcerptTokenReferenceResultType.Export
        ) {
            const destination = getLinkToApiItem(
                getApiItemName(apiItem),
                result.apiItem,
                context,
            );
            isOnlyText = false;
            richCodeBlock.children.push(
                LocalPageLinkNode({
                    destination,
                    children: [PlainTextNode({ text: tokenText })],
                }),
            );
        } else {
            // Local signature reference.
            spannedTokens.unshift(...result.tokens);
        }
    }

    if (isOnlyText) {
        let formattedText = removeExportDeclare(excerpt.text);
        if (apiItem.kind !== aeModel.ApiItemKind.Interface) {
            try {
                formattedText = format(
                    removeExportDeclare(excerpt.text),
                    Language.TypeScript,
                ).trim();
            } catch (error) {
                console.error(error);
                formattedText = excerpt.text;
            }
        }
        const codeBlock = CodeBlockNode({
            language: 'ts',
            code: formattedText,
        });
        container.children.push(codeBlock);
        return;
    }

    container.children.push(richCodeBlock);
}
