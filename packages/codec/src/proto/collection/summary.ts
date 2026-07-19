/**
 * The eight collection content summaries — one per collection `type`.
 *
 * Column `180015` holds a tagged union: exactly one sub-message is present,
 * keyed by a sub-tag `180649 + type`:
 *
 *   type 1  text      → 180650   (children base 180750)
 *   type 2  link      → 180651   (children base 180850)
 *   type 3  gallery   → 180652   (children base 180950)
 *   type 4  audio     → 180653   (children base 181050)
 *   type 5  video     → 180654   (children base 181150)
 *   type 6  file      → 180655   (children base 181250)
 *   type 7  location  → 180656   (children base 181350)
 *   type 8  richMedia → 180657   (children base 181450)
 *
 * Children base = 180850 + (type − 2) × 100. link/audio/video/file/location/
 * richMedia are verified against real samples; text & gallery are predicted
 * from the pattern (modern QQ folds single text/image into richMedia, so they
 * rarely materialize) and left minimal — unknown fields simply decode to
 * nothing rather than throwing.
 */

import { ProtoField, ScalarType } from '../../core';
import { PicInfo, FileInfo } from './common';

/** type 1 — plain text note. Predicted (unsampled). */
export const TextSummary = {
  /** Tag 180750: Text body. */
  text: ProtoField(180750, ScalarType.STRING, { optional: true }),
};

/** type 2 — link / mini-program / web page. */
export const LinkSummary = {
  /** Tag 180850: Target url. */
  url: ProtoField(180850, ScalarType.STRING, { optional: true }),
  /** Tag 180851: Title. */
  title: ProtoField(180851, ScalarType.STRING, { optional: true }),
  /** Tag 180852: Publisher / source. */
  publisher: ProtoField(180852, ScalarType.STRING, { optional: true }),
  /** Tag 180853: Brief / description. */
  brief: ProtoField(180853, ScalarType.STRING, { optional: true }),
  /** Tag 180854: Cover image(s). */
  picList: ProtoField(180854, () => PicInfo, { optional: true, repeat: true }),
  /** Tag 180855: Link sub-type. */
  type: ProtoField(180855, ScalarType.INT32, { optional: true }),
  /** Tag 180856: Resource url (e.g. mini-program icon). */
  resourceUrl: ProtoField(180856, ScalarType.STRING, { optional: true }),
};

/** type 3 — pure image gallery. Predicted (unsampled). */
export const GallerySummary = {
  /** Tag 180950: Images. */
  picList: ProtoField(180950, () => PicInfo, { optional: true, repeat: true }),
};

/** type 4 — audio / voice. */
export const AudioSummary = {
  /** Tag 181050: Duration (ms). */
  duration: ProtoField(181050, ScalarType.INT32, { optional: true }),
  /** Tag 181051: Speech-to-text transcript. */
  stt: ProtoField(181051, ScalarType.STRING, { optional: true }),
  /** Tag 181052: Extra. */
  extra: ProtoField(181052, ScalarType.STRING, { optional: true }),
};

/** type 5 — video. */
export const VideoSummary = {
  /** Tag 181150: Title. */
  title: ProtoField(181150, ScalarType.STRING, { optional: true }),
  /** Tag 181151: Duration (s). */
  duration: ProtoField(181151, ScalarType.INT32, { optional: true }),
  /** Tag 181152: Format. */
  format: ProtoField(181152, ScalarType.INT32, { optional: true }),
  /** Tag 181153: Category. */
  category: ProtoField(181153, ScalarType.INT32, { optional: true }),
  /** Tag 181154: Preview type. */
  previewType: ProtoField(181154, ScalarType.INT32, { optional: true }),
  /** Tag 181155: Preview image. */
  previewPicInfo: ProtoField(181155, () => PicInfo, { optional: true }),
  /** Tag 181156: Store type. */
  storeType: ProtoField(181156, ScalarType.INT32, { optional: true }),
  /** Tag 181157: Stored video file. */
  storeFileInfo: ProtoField(181157, () => FileInfo, { optional: true }),
};

/** type 6 — file. */
export const FileSummary = {
  /** Tag 181250: Stored (collector) file. */
  fileInfo: ProtoField(181250, () => FileInfo, { optional: true }),
  /** Tag 181251: Original source file. */
  srcFileInfo: ProtoField(181251, () => FileInfo, { optional: true }),
};

/** type 7 — location. lat/lng/alt are fixed32 floats. */
export const LocationSummary = {
  /** Tag 181350: Place name. */
  name: ProtoField(181350, ScalarType.STRING, { optional: true }),
  /** Tag 181351: Latitude. */
  latitude: ProtoField(181351, ScalarType.FLOAT, { optional: true }),
  /** Tag 181352: Longitude. */
  longitude: ProtoField(181352, ScalarType.FLOAT, { optional: true }),
  /** Tag 181353: Altitude. */
  altitude: ProtoField(181353, ScalarType.FLOAT, { optional: true }),
  /** Tag 181354: Address. */
  address: ProtoField(181354, ScalarType.STRING, { optional: true }),
  /** Tag 181355: Note. */
  note: ProtoField(181355, ScalarType.STRING, { optional: true }),
};

/** type 8 — rich media (text + images; also forwarded chat records). */
export const RichMediaSummary = {
  /** Tag 181450: Title. */
  title: ProtoField(181450, ScalarType.STRING, { optional: true }),
  /** Tag 181451: Sub-title. */
  subTitle: ProtoField(181451, ScalarType.STRING, { optional: true }),
  /** Tag 181452: Brief / body preview. */
  brief: ProtoField(181452, ScalarType.STRING, { optional: true }),
  /** Tag 181453: Embedded images. */
  picList: ProtoField(181453, () => PicInfo, { optional: true, repeat: true }),
  /** Tag 181454: Content type. */
  contentType: ProtoField(181454, ScalarType.INT32, { optional: true }),
  /** Tag 181455: Original uri. */
  originalUri: ProtoField(181455, ScalarType.STRING, { optional: true }),
  /** Tag 181456: Publisher. */
  publisher: ProtoField(181456, ScalarType.STRING, { optional: true }),
  /** Tag 181457: Rich-media version. */
  richMediaVersion: ProtoField(181457, ScalarType.INT32, { optional: true }),
};

/**
 * The content union carried by column `180015`. Exactly one field is set,
 * matching the row's `type`. Decoding is robust: an unknown/absent sub-tag
 * yields an all-undefined object rather than an error.
 */
export const CollectionContent = {
  textSummary: ProtoField(180650, () => TextSummary, { optional: true }),
  linkSummary: ProtoField(180651, () => LinkSummary, { optional: true }),
  gallerySummary: ProtoField(180652, () => GallerySummary, { optional: true }),
  audioSummary: ProtoField(180653, () => AudioSummary, { optional: true }),
  videoSummary: ProtoField(180654, () => VideoSummary, { optional: true }),
  fileSummary: ProtoField(180655, () => FileSummary, { optional: true }),
  locationSummary: ProtoField(180656, () => LocationSummary, { optional: true }),
  richMediaSummary: ProtoField(180657, () => RichMediaSummary, { optional: true }),
};

export { AuthorInfo, PicInfo, FileInfo } from './common';
