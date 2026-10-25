'use strict';

const { publicMedia, publicUrl } = require('../../../utils/public-media');
const modifiers = ['bold', 'italic', 'underline', 'strikethrough', 'code'];

function textNode(node) {
  if (node?.type !== 'text' || typeof node.text !== 'string') return null;
  const result = { type: 'text', text: node.text };
  for (const name of modifiers) {
    if (typeof node[name] === 'boolean') result[name] = node[name];
  }
  return result;
}

function inlineNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  const result = [];
  for (const node of nodes) {
    const text = textNode(node);
    if (text) {
      result.push(text);
    } else if (node?.type === 'link' && Array.isArray(node.children)) {
      const children = node.children.map(textNode).filter(Boolean);
      const url = publicUrl(node.url, true);
      if (url) result.push({ type: 'link', url, children });
      else result.push(...children);
    }
  }
  return result;
}

function blockNode(node, depth) {
  if (!node || depth > 32) return null;
  if (node.type === 'image') {
    const image = publicMedia(node.image);
    if (!image) return null;
    return { type: 'image', image, children: [{ type: 'text', text: '' }] };
  }
  if (!Array.isArray(node.children)) return null;
  if (node.type === 'list' && ['ordered', 'unordered'].includes(node.format)) {
    const children = [];
    for (const child of node.children) {
      if (child?.type === 'list-item' && Array.isArray(child.children)) {
        children.push({ type: 'list-item', children: inlineNodes(child.children) });
      } else if (child?.type === 'list') {
        const nested = blockNode(child, depth + 1);
        if (nested) children.push(nested);
      }
    }
    return { type: 'list', format: node.format, children };
  }
  if (node.type === 'heading' && Number.isInteger(node.level) && node.level >= 1 && node.level <= 6) {
    return { type: 'heading', level: node.level, children: inlineNodes(node.children) };
  }
  if (['paragraph', 'quote', 'code'].includes(node.type)) {
    return { type: node.type, children: inlineNodes(node.children) };
  }
  return null;
}

function publicBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.map(node => blockNode(node, 0)).filter(Boolean);
}

module.exports = { publicBlocks };
