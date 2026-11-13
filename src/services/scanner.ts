// 本地有声书扫描器：从 pluginDataDir 下的某个目录扫描书籍/章节文件

import type { Book, Chapter } from "../types";
import {
  isAudioFile,
  isImageFile,
  isDescFile,
  naturalSort,
  stripExt,
  safeId,
  estimateDurationFromSize,
} from "../utils/helpers";

export interface ScannerState {
  scannedAt?: number;
  // Exact metadata manifests avoid hash collisions and never read audio payloads.
  directoryManifests?: Record<string, string>;
  books: Book[];
  chaptersByBookId: Record<string, Chapter[]>;
}

export const DEFAULT_LIBRARY_PATH = "/app/audiobook";

const MAX_SCAN_DEPTH = 6;
const IGNORED_DIRECTORIES = new Set([
  "@eaDir",
  "@Recycle",
  "#recycle",
  ".cache",
  ".snapshot",
  ".AppleDouble",
  "@tmp",
]);

function isLibraryEntry(entry: DirEntry): boolean {
  return !entry.isDir || !IGNORED_DIRECTORIES.has(entry.name);
}

type FileStat = { size: number; modTime: number };
type DirEntry = {
  name: string;
  isDir: boolean;
  size?: number;
  modTime?: number;
};

async function readEntries(path: string): Promise<DirEntry[]> {
  await yieldScan();
  return (songloft.fs.readdir as any)(path, { withStats: true });
}

function entryStats(
  entries: DirEntry[],
  path: string,
): Record<string, FileStat> {
  const stats: Record<string, FileStat> = {};
  for (const e of entries) {
    if (
      !e.isDir &&
      typeof e.size === "number" &&
      typeof e.modTime === "number"
    ) {
      stats[`${path}/${e.name}`] = { size: e.size, modTime: e.modTime };
    }
  }
  return stats;
}

// Give HTTP requests and other plugins time between background scan batches.
async function yieldScan(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

interface WalkResult {
  stats: Record<string, FileStat>;
  audios: string[];
  coverRel: string | null;
  descRel: string | null;
  manifests: string[];
  complete: boolean;
  rootEntries?: DirEntry[];
}

/**
 * 递归扫描目录，收集音频文件、封面和描述文件，最深 maxDepth 层
 * depth: 当前递归深度（0 起始）
 */
async function walkDir(
  dirPath: string,
  depth: number,
  maxDepth: number,
  result: WalkResult = {
    audios: [],
    stats: {},
    coverRel: null,
    descRel: null,
    manifests: [],
    complete: true,
  },
): Promise<WalkResult> {
  let entries: DirEntry[] = [];
  try {
    entries = ((await readEntries(dirPath)) || []).filter(isLibraryEntry);
  } catch {
    throw new Error(`无法读取目录: ${dirPath}`);
  }
  if (depth === 0) result.rootEntries = entries;
  const canonical = entries.map((e) => [e.name, e.isDir, e.size, e.modTime]);
  canonical.sort((a, b) =>
    String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0,
  );
  result.manifests.push(JSON.stringify([dirPath, canonical]));
  for (const e of entries) {
    if (
      !e.isDir &&
      (typeof e.size !== "number" || typeof e.modTime !== "number")
    )
      result.complete = false;
  }
  for (const e of entries) {
    const fullPath = `${dirPath}/${e.name}`;
    if (e.isDir) {
      if (depth < maxDepth) {
        await walkDir(fullPath, depth + 1, maxDepth, result);
      }
    } else {
      if (isAudioFile(e.name)) {
        result.audios.push(fullPath);
        if (typeof e.size === "number" && typeof e.modTime === "number")
          result.stats[fullPath] = { size: e.size, modTime: e.modTime };
      }
      if (!result.coverRel && isImageFile(e.name)) {
        const lower = e.name.toLowerCase();
        const base = lower.substring(0, lower.lastIndexOf("."));
        if (base === "cover" || base === "folder" || base === "封面") {
          result.coverRel = fullPath;
        }
      }
      if (!result.descRel && isDescFile(e.name)) {
        result.descRel = fullPath;
      }
    }
  }

  return result;
}

/** 扫描整个库目录并返回索引 */
export async function scanLibrary(
  previous?: ScannerState,
): Promise<ScannerState> {
  const libraryPath = DEFAULT_LIBRARY_PATH;
  const state: ScannerState = {
    books: [],
    chaptersByBookId: {},
    directoryManifests: {},
  };
  const cached = previous || (await loadLibraryIndex());
  let reused = 0;

  let entries: DirEntry[] = [];
  try {
    entries = ((await readEntries(libraryPath)) || []).filter(isLibraryEntry);
  } catch (err) {
    songloft.log.warn(
      `有声书库路径不存在或无法访问: ${libraryPath} (${String(err)})`,
    );
    throw err;
  }

  if (entries.length === 0) {
    songloft.log.info(`有声书库为空: ${libraryPath}`);
    state.scannedAt = Date.now();
    return state;
  }

  const folders: string[] = [];
  const rootAudios: string[] = [];

  for (const e of entries) {
    if (e.isDir) {
      folders.push(e.name);
    } else if (isAudioFile(e.name)) {
      rootAudios.push(e.name);
    }
  }

  // 扫描每个子目录为一本书
  for (const folder of folders) {
    await yieldScan();
    try {
      const oldBook = cached?.books.find(
        (book) => book.folderRelPath === `${libraryPath}/${folder}`,
      );
      const oldChapters = oldBook && cached.chaptersByBookId[oldBook.id];
      const result = await scanBookFolder(
        libraryPath,
        folder,
        oldBook,
        oldChapters,
        cached?.directoryManifests?.[folder],
      );
      if (result && result.chapters.length > 0) {
        state.books.push(result.book);
        state.chaptersByBookId[result.book.id] = result.chapters;
        if (result.manifest) state.directoryManifests[folder] = result.manifest;
        if (result.reused) reused++;
      }
    } catch (err) {
      songloft.log.warn(`扫描文件夹 '${folder}' 失败: ${String(err)}`);
      const oldBook = cached?.books.find(
        (book) => book.folderRelPath === `${libraryPath}/${folder}`,
      );
      if (oldBook) {
        state.books.push(oldBook);
        state.chaptersByBookId[oldBook.id] =
          cached.chaptersByBookId[oldBook.id] || [];
      }
    }
  }

  // 根目录散落的音频文件 → 合并到一本"未分类"书籍
  if (rootAudios.length > 0) {
    try {
      const result = await buildMiscBook(
        libraryPath,
        rootAudios,
        entryStats(entries, libraryPath),
      );
      if (result && result.chapters.length > 0) {
        state.books.push(result.book);
        state.chaptersByBookId[result.book.id] = result.chapters;
      }
    } catch (err) {
      songloft.log.warn(`未分类音频扫描失败: ${String(err)}`);
    }
  }

  // 按最近更新时间排序
  state.books.sort((a, b) => b.updatedAt - a.updatedAt);

  songloft.log.info(
    `有声书扫描完成：共 ${state.books.length} 本书，复用 ${reused} 本未变化索引`,
  );
  state.scannedAt = Date.now();
  return state;
}

async function scanBookFolder(
  libraryPath: string,
  folder: string,
  oldBook?: Book,
  oldChapters?: Chapter[],
  oldManifest?: string,
): Promise<{
  book: Book;
  chapters: Chapter[];
  manifest?: string;
  reused?: boolean;
} | null> {
  const folderRel = `${libraryPath}/${folder}`;

  const result = await walkDir(folderRel, 0, MAX_SCAN_DEPTH);
  // Include the scanner version and all descendant entries, not just parent mtime.
  const manifest = result.complete
    ? JSON.stringify([2, ...result.manifests.sort()])
    : undefined;
  if (
    manifest &&
    manifest === oldManifest &&
    oldBook &&
    oldChapters &&
    oldChapters.length === result.audios.length
  ) {
    return { book: oldBook, chapters: oldChapters, manifest, reused: true };
  }

  if (result.audios.length === 0) return null;

  // Bootstrap old caches by validating every audio path, size and timestamp.
  const oldPaths = new Set(oldChapters?.map((chapter) => chapter.fileRelPath));
  const sameAudio =
    oldChapters &&
    oldChapters.length === result.audios.length &&
    oldPaths.size === result.audios.length &&
    result.audios.every((path) => oldPaths.has(path)) &&
    oldChapters.every((chapter) => {
      const st = result.stats[chapter.fileRelPath];
      return (
        st && st.size === chapter.fileSize && st.modTime === chapter.modTime
      );
    });
  if (!sameAudio) naturalSort(result.audios);

  const chapters: Chapter[] = sameAudio ? oldChapters : [];
  let latestMod = 0;
  let totalSize = 0;
  const bookId = safeId(folder);

  if (sameAudio) {
    for (const chapter of chapters) {
      latestMod = Math.max(latestMod, chapter.modTime || 0);
      totalSize += chapter.fileSize || 0;
    }
  }
  for (let i = 0; !sameAudio && i < result.audios.length; i++) {
    if (i > 0 && i % 64 === 0) await yieldScan();
    const rel = result.audios[i];
    try {
      const st = result.stats[rel] || (await songloft.fs.stat(rel));
      const size = Number(st.size || 0);
      const mod = Number(st.modTime || 0);
      if (mod > latestMod) latestMod = mod;
      totalSize += size;

      const fileName = rel.substring(rel.lastIndexOf("/") + 1);

      chapters.push({
        id: `${bookId}-ch${String(i + 1).padStart(3, "0")}`,
        index: i + 1,
        title: stripExt(fileName),
        duration: estimateDurationFromSize(size),
        fileSize: size,
        fileRelPath: rel,
        modTime: mod,
      });
    } catch (err) {
      throw new Error(`stat 失败: ${rel} (${String(err)})`);
    }
  }

  if (chapters.length === 0) return null;

  let coverRel = result.coverRel;
  let descRel = result.descRel;

  // 如果在子目录中未找到命名封面，尝试根目录的任何图片
  if (!coverRel) {
    try {
      const rootEntries = result.rootEntries || [];
      for (const e of rootEntries) {
        if (!e.isDir && isImageFile(e.name)) {
          coverRel = `${folderRel}/${e.name}`;
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  let description = "";
  let category = "默认";
  let tags: string[] = [];
  let author = "未知";
  let coverRatio = "";

  // 优先读取 metadata.json
  try {
    const metaRaw = await songloft.fs.readFile(`${folderRel}/metadata.json`);
    if (metaRaw) {
      const meta = JSON.parse(metaRaw);
      if (meta.description) description = meta.description;
      if (meta.category) category = meta.category;
      if (meta.tags) tags = meta.tags;
      if (meta.author) author = meta.author;
      if (meta.coverRatio) coverRatio = meta.coverRatio;
    }
  } catch (err) {
    if (
      result.rootEntries?.some(
        (entry) => entry.name === "metadata.json" && !entry.isDir,
      )
    ) {
      throw new Error(`无法读取书籍元数据: ${String(err)}`);
    }
  }

  if (!description && descRel) {
    try {
      description = ((await songloft.fs.readFile(descRel)) || "").trim();
    } catch (err) {
      throw new Error(`无法读取书籍描述: ${String(err)}`);
    }
  }

  const book: Book = {
    id: bookId,
    title: folder,
    author,
    coverUrl: coverRel,
    coverRatio,
    description: description || `共 ${chapters.length} 章`,
    category,
    tags,
    updatedAt: latestMod || Date.now(),
    chapterCount: chapters.length,
    totalSize,
    folderRelPath: folderRel,
  };

  return {
    book,
    chapters: sameAudio ? oldChapters : chapters,
    manifest,
    reused: !!sameAudio,
  };
}

async function buildMiscBook(
  libraryPath: string,
  audios: string[],
  stats: Record<string, FileStat>,
): Promise<{ book: Book; chapters: Chapter[] } | null> {
  if (audios.length === 0) return null;
  naturalSort(audios);

  const chapters: Chapter[] = [];
  let latestMod = 0;
  let totalSize = 0;

  for (let i = 0; i < audios.length; i++) {
    if (i > 0 && i % 64 === 0) await yieldScan();
    const rel = `${libraryPath}/${audios[i]}`;
    try {
      const st = stats[rel] || (await songloft.fs.stat(rel));
      const size = Number(st.size || 0);
      const mod = Number(st.modTime || 0);
      if (mod > latestMod) latestMod = mod;
      totalSize += size;
      chapters.push({
        id: `misc-ch${String(i + 1).padStart(3, "0")}`,
        index: i + 1,
        title: stripExt(audios[i]),
        duration: estimateDurationFromSize(size),
        fileSize: size,
        fileRelPath: rel,
        modTime: mod,
      });
    } catch {
      // ignore
    }
  }

  if (chapters.length === 0) return null;

  const book: Book = {
    id: "misc-audio",
    title: "未分类音频",
    author: "未知",
    coverUrl: null,
    coverRatio: "",
    description: "有声书库根目录下的零散音频文件",
    category: "未分类",
    tags: [],
    updatedAt: latestMod || Date.now(),
    chapterCount: chapters.length,
    totalSize,
    folderRelPath: libraryPath,
  };

  return { book, chapters };
}

// ---------- 索引持久化 ----------

const STORAGE_KEY = "audiobook_library_v1";

export async function saveLibraryIndex(state: ScannerState): Promise<void> {
  try {
    await songloft.storage.set(
      STORAGE_KEY,
      state as unknown as Record<string, unknown>,
    );
  } catch (err) {
    songloft.log.warn(`saveLibraryIndex 失败: ${String(err)}`);
  }
}

export async function loadLibraryIndex(): Promise<ScannerState | null> {
  try {
    const raw = await songloft.storage.get(STORAGE_KEY);
    if (!raw) return null;
    return raw as unknown as ScannerState;
  } catch {
    return null;
  }
}

/** 辅助：根据 bookId 从 state 中获取 BookDetail */
export function getBookDetail(
  state: ScannerState,
  bookId: string,
): (Book & { chapters: Chapter[] }) | null {
  const book = state.books.find((b) => b.id === bookId);
  if (!book) return null;
  const chapters = state.chaptersByBookId[bookId] || [];
  return { ...book, chapters };
}
