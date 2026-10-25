'use strict';

/**
 * A garden's plots: the beds on its Explore island, one plant each, in layout
 * order. Stored as a repeatable component on the garden, read and written the
 * same way as the standing task list (see day-sheet-standing-task service).
 */

const MAX_PLOTS = 64;
const MAX_LABEL = 60;

// Only what the island and its plant panel show; never the whole plant record.
const PLANT_FIELDS = ['id', 'documentId', 'title', 'latin', 'type', 'slug', 'sun_detail', 'water_detail'];

const err = (message) => Object.assign(new Error(message), { plotValidationError: true });

module.exports = ({ strapi }) => ({
  MAX_PLOTS,

  /**
   * Shared validation for the write path. Throws a tagged error the controller
   * turns into a 400. Messages never echo submitted text back.
   *
   * Each item is { label?: string, plant: string | null }, where plant is a
   * plant documentId (null leaves the bed empty).
   */
  async validatePlots(items) {
    if (!Array.isArray(items)) throw err('plots must be an array');
    if (items.length > MAX_PLOTS) throw err(`plots may contain at most ${MAX_PLOTS} items`);

    const cleaned = items.map((item, n) => {
      let label = null;
      const rawLabel = item?.label;
      if (rawLabel !== null && rawLabel !== undefined && rawLabel !== '') {
        if (typeof rawLabel !== 'string') throw err('Plot ' + n + ': label must be a string');
        label = rawLabel.replace(/[\x00-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim() || null;
        if (label && label.length > MAX_LABEL) throw err('Plot ' + n + `: label must be ${MAX_LABEL} characters or fewer`);
      }

      const plant = item?.plant ?? null;
      if (plant !== null && (typeof plant !== 'string' || !/^[a-z0-9]{1,64}$/i.test(plant))) {
        throw err('Plot ' + n + ': plant must be a plant id or null');
      }
      return { label, plant };
    });

    // Every named plant has to exist, or the save would quietly drop the link.
    const wanted = [...new Set(cleaned.map((p) => p.plant).filter(Boolean))];
    if (wanted.length) {
      const found = await strapi.db.query('api::plant.plant').findMany({
        where: { documentId: { $in: wanted } },
        select: ['documentId'],
      });
      const known = new Set(found.map((p) => p.documentId));
      cleaned.forEach((p, n) => {
        if (p.plant && !known.has(p.plant)) throw err('Plot ' + n + ': plant not found');
      });
    }
    return cleaned;
  },

  /** Shape stored component rows into what the island draws. */
  toPlots(raw) {
    return (Array.isArray(raw) ? raw : []).map((p) => ({
      id: p.id,
      label: p.label || null,
      plant: p.plant
        ? {
          ...Object.fromEntries(PLANT_FIELDS.map((f) => [f, p.plant[f] ?? null])),
          clipart: p.plant.clipart ? { url: p.plant.clipart.url } : null,
          images: (p.plant.images || []).slice(0, 1).map((img) => ({ url: img.url, formats: img.formats || null })),
          // What the plant gives; Explore adds these up across the garden.
          Benefits: (p.plant.Benefits || []).map((b) => ({ title: b.title, potency: b.potency })),
        }
        : null,
    }));
  },

  /**
   * The garden's plots. Garden has draft/publish on, so it can exist as two
   * rows sharing a documentId; read the DRAFT, which is the row the Documents
   * API writes (see replaceForGarden). `saved` is false until a manager has
   * laid out plots, so the island can fall back to plants logged nearby.
   */
  async getForGarden(garden) {
    const rows = await strapi.db.query('api::garden.garden').findMany({
      where: { documentId: garden.documentId },
      populate: {
        plots: {
          populate: {
            plant: { select: PLANT_FIELDS, populate: { clipart: true, images: true, Benefits: true } },
          },
        },
      },
    });
    const preferred = rows.find((r) => r.publishedAt == null) || rows[0];
    const plots = this.toPlots(preferred?.plots);
    return { plots, saved: plots.length > 0 };
  },

  /** Replace one garden's plots wholesale. Order is the layout order. */
  async replaceForGarden(garden, items) {
    const cleaned = await this.validatePlots(items);
    // The Documents API, not db.query: it creates the component rows and links
    // each plant by documentId. No publish(), for the same reason the standing
    // list skips it: publishing validates the whole garden, and laying out
    // beds shouldn't be blocked by an unrelated missing field.
    await strapi.documents('api::garden.garden').update({
      documentId: garden.documentId,
      data: { plots: cleaned.map((p) => ({ label: p.label, plant: p.plant })) },
    });
    return this.getForGarden(garden);
  },
});
