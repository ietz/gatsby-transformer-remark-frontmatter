import { Node } from 'gatsby'
export const NODE_TYPE = 'FrontmatterMarkdownFile'

export type FrontmatterMarkdownFileNode = Node & {
  frontmatterField: string
  frontmatterValue: string
}

export type PluginOptions =
  | { whitelist: string[] }
  | { blacklist: string[] }
  | undefined

export const isFrontmatterMarkdownFileNode = (
  n: Node,
): n is FrontmatterMarkdownFileNode => n.internal.type === NODE_TYPE

export const isFrontmatterMarkdownNode = ({
  node,
  getNode,
}: {
  node: Node
  getNode: Function
}) => {
  const parent = node.parent ? getNode(node.parent) : null
  return !!(parent && isFrontmatterMarkdownFileNode(parent))
}

export * from './gatsby-node'
