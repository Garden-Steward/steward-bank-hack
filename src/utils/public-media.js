'use strict';

function publicUrl(value, editorial = false) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/u.test(value)) return null;
  if (value.startsWith('/') && !value.startsWith('//')) {
    if (editorial || value.startsWith('/uploads/')) return value;
    return null;
  }
  if (editorial && value.startsWith('#')) return value;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'http:' || url.protocol === 'https:') return value;
    if (editorial && (url.protocol === 'mailto:' || url.protocol === 'tel:')) return value;
  } catch {
    return null;
  }
  return null;
}

function dimension(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return null;
}

function publicMedia(media) {
  const url = publicUrl(media?.url);
  if (!url) return null;
  const formats = {};
  for (const name of ['thumbnail', 'small', 'medium', 'large']) {
    const format = media.formats?.[name];
    const formatUrl = publicUrl(format?.url);
    if (formatUrl) formats[name] = { url: formatUrl, width: dimension(format.width), height: dimension(format.height) };
  }
  return {
    url,
    alternativeText: media.alternativeText ?? null,
    width: dimension(media.width),
    height: dimension(media.height),
    formats,
  };
}

const mediaFields = ['url', 'alternativeText', 'width', 'height', 'formats'];
module.exports = { publicMedia, publicUrl, mediaFields };
