'use strict';

function publicUrl(value, editorial = false) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/u.test(value) || value.startsWith('//')) return null;
  try {
    let url;
    if (editorial || value.startsWith('/')) url = new URL(value, 'https://public.invalid');
    else url = new URL(value);
    if (url.username || url.password) return null;
    if (value.startsWith('/')) {
      if (editorial || url.pathname.startsWith('/uploads/')) return value;
      return null;
    }
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
  let alternativeText = null;
  if (typeof media.alternativeText === 'string') alternativeText = media.alternativeText;
  return {
    url,
    alternativeText,
    width: dimension(media.width),
    height: dimension(media.height),
    formats,
  };
}

const mediaFields = ['url', 'alternativeText', 'width', 'height', 'formats'];
module.exports = { publicMedia, publicUrl, mediaFields };
