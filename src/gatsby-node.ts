import _ from 'lodash'
import { Node, GatsbyNode, NodePluginArgs } from 'gatsby'
import {
  NODE_TYPE,
  isFrontmatterMarkdownNode,
  FrontmatterMarkdownFileNode,
} from './index'

// map of node ids to field names to created frontmatter markdown nodes.
// When the FrontmatterFile node is created, a new entry is added with
// all fields set to null
// we know that the frontmattermd field is ready to be created if all
// field_names are set to the string ids of the created markdown nodes

const node_field_map: {
  [markdown_node_id: string]: object,
} = {}

const node_remaining_fields: {
  [markdown_node_id: string]: Set<string>,
} = {}


type Schema = null | SchemaMap | SchemaArray
interface SchemaMap {[key: string]: Schema}
interface SchemaArray extends Array<Schema> {}

type Values = {[key: string]: any}

type Structure = {schema: Schema, values: Values}


const destructureFrontmatter = (frontmatter: any): Structure => {
  return {
    schema: objectSchema(frontmatter),
    values: objectValues(frontmatter),
  }
}


const objectSchema = (obj: any): Schema => {
  if (Array.isArray(obj)) {
    return obj.map(objectSchema)

  } else if ((typeof obj) === 'object') {
    return Object.entries(obj)
      .reduce((acc, [key, value]) => ({...acc, [key]: objectSchema(value)}), {})

  } else {
    return null
  }
}

const objectValues = (obj: any): Values => {
  if ((typeof obj) === 'object') {
    return Object.entries(obj)
      .reduce((acc, [itemKey, item]) => ({
        ...acc,
        ..._.mapKeys(objectValues(item), (nestedValue: any, nestedKey: string) => `[${JSON.stringify(itemKey)}]${nestedKey}`)
      }), {})

  } else {
    return {'': obj}
  }
}

const getFieldMap = (node: Node) => node_field_map[node.id]

const setFieldMarkdownNode = (node: Node, field_name: string, markdownNode: Node) => {
  if (!node_field_map[node.id]) node_field_map[node.id] = {}
  if (!node_remaining_fields[node.id]) node_remaining_fields[node.id] = new Set<string>()

  const path = _.toPath(field_name)
  const nodePath = [...path.slice(0, -1), `${path[path.length-1]}___NODE`]

  node_remaining_fields[node.id].delete(field_name)

  const fields = node_field_map[node.id]
  _.unset(fields, path)
  _.set(fields, nodePath, markdownNode.id)
}

const nodeIsReady = (node: Node) =>
  node_remaining_fields[node.id]
  && node_remaining_fields[node.id].size === 0

const shouldUseField = (filter: {
  kind: 'whitelist' | 'blacklist'
  fields: string[]
}) => ([key, value]: [string, any]) => {
  if (filter.kind === 'blacklist' && filter.fields.includes(key)) return false
  if (filter.kind === 'whitelist' && !filter.fields.includes(key)) return false
  return !!(typeof value === 'string' && value)
}

const createFrontmatterMdFileNode = (
  {
    createNodeId,
    createContentDigest,
    getNode,
    actions: { createNode, createParentChildLink },
  }: NodePluginArgs,
  [field, value]: [string, string],
  parent: Node,
) => {
  const parentParent = parent.parent && getNode(parent.parent)
  const fileParent =
    parentParent && parentParent.internal.type === 'File' ? parentParent : null

  const frontmatterMdNode = ({
    // lots of plugins check if a markdown node's parent has file attributes
    // (gatsby-remark-images checks for `dir`) but don't actually check if
    // internal.type is File. This is good for us, we can pretend that this
    // is a File, which lets us support those plugins with no downsides.
    // unfortunately if a plugin does a more throughough check, this will fail
    // and there is no alternative. Ideally plugins should just check for
    // the fields that they use, or recursively check all parents until a File
    // is found
    ...fileParent,
    id: createNodeId(`${parent.id}:${field} >>> ${NODE_TYPE}`),
    parent: parent.id,
    children: [],
    internal: {
      content: value,
      contentDigest: createContentDigest(value),
      mediaType: 'text/markdown',
      type: NODE_TYPE,
    },
  } as unknown) as FrontmatterMarkdownFileNode
  frontmatterMdNode.frontmatterField = field
  frontmatterMdNode.frontmatterValue = value

  // errors if fields are set on a new node
  // unfortunately we can't reuse any third-party
  // changes to file nodes
  delete frontmatterMdNode.fields

  // creation is deferred since we could have a race
  // condition if we create a node before the node_field_map
  // has been entirely populated. onCreateNode is async
  // so the linkNodes fn could be called and think that
  // it's ready to add the frontmattermd, but in reality
  // we just haven't yet added all of the fields to the
  // node_field_map (our Object.entries iteration hasn't
  // completed yet)
  return () => {
    createNode(frontmatterMdNode)
    if (parent) createParentChildLink({ parent, child: frontmatterMdNode })
  }
}

/**
 * Creates the FrontmatterMarkdownFile nodes from the
 * valid frontmatter fields of a MarkdownRemark node
 * @param node the MarkdownRemark node
 * @param helpers NodePluginArgs
 * @param filter a predicate to filter vaild frontmatter fields
 */
const createFrontmatterNodes = (
  node: Node,
  helpers: NodePluginArgs,
  filter: ReturnType<typeof shouldUseField>,
) => {
  const { getNode } = helpers
  if (isFrontmatterMarkdownNode({ node, getNode })) return

  const {schema, values} = destructureFrontmatter(node.frontmatter)
  if (!schema) return

  node_field_map[node.id] = schema
  node_remaining_fields[node.id] = new Set<string>(Object.keys(values))

  const createFns = Object.entries(values).reduce(
    (acc, pair) => {
      if (filter(pair)) {
        acc.push(createFrontmatterMdFileNode(helpers, pair, node))
      }

      return acc
    },
    [] as Array<() => void>,
  )

  // actually create the FrontmatterMarkdownFile nodes
  createFns.map(fn => fn())
}

/**
 * Links the MarkdownRemark nodes created by gatsby-transformer-remark
 * to the original MarkdownRemark node where the frontmatter came from
 * using the frontmattermd field
 *
 * @param node a MarkdownRemark node
 * @param helpers NodePluginArgs
 */
const linkNodes = (node: Node, helpers: NodePluginArgs) => {
  const {
    getNode,
    actions: { createNodeField },
  } = helpers
  // we only operate on MarkdownRemark nodes that are children of FrontmatterMarkdownFile nodes
  if (!isFrontmatterMarkdownNode({ node, getNode })) return
  // get the parent, the FrontmatterMarkdownFile node
  const fileNode = getNode(node.parent)! as FrontmatterMarkdownFileNode
  // get the parent's parent, the original MarkdownNode
  const markdownNode = getNode(fileNode.parent)!

  const field = fileNode.frontmatterField

  // add the node id to the map
  setFieldMarkdownNode(markdownNode, field, node)
  if (!nodeIsReady(markdownNode)) return;

  const map_entry = getFieldMap(markdownNode)
  createNodeField({
    name: 'frontmattermd',
    node: markdownNode,
    value: map_entry,
  })
}

export const onCreateNode: Exclude<
  GatsbyNode['onCreateNode'],
  undefined
  > = async (helpers, pluginOptions = { plugins: [] }) => {
  const { node } = helpers

  const { whitelist, blacklist } = pluginOptions as {
    whitelist?: string[]
    blacklist?: string[]
  }

  if (whitelist && blacklist) {
    throw new Error(
      'Cannot provide both a whitelist and a blacklist to gatsby-transformer-remark-frontmatter',
    )
  }

  const filter = shouldUseField(
    whitelist
      ? { kind: 'whitelist', fields: whitelist }
      : { kind: 'blacklist', fields: blacklist || [] },
  )

  if (!node || node.internal.type !== 'MarkdownRemark') return
  createFrontmatterNodes(node, helpers, filter)
  linkNodes(node, helpers)
}
