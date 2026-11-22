// Files: the server as a NAS. Browse, preview, upload, download, organise, share on the network.
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  mutate,
  query,
  type FileEntry,
  type Listing,
  type SmbShare,
  diskPct,
} from "../api";
import { useBootstrap, useDisk, useUser } from "../data";
import { ComputerFolder } from "../fleet/ComputerFolder";
import { computerPlacePath, filePlaces, filesParent, parseComputerPlace, SERVER_FILES } from "../fleet/filePlaces";
import { NuEntries, type NuItem } from "../fleet/NuEntries";
import { queryProblem, useBrowserOnline } from "../connection";
import { Icon, type IconName } from "../icons";
import { Card, CardHead, Sheet, SheetHeader, bytes, haptic, scrollPhoneToTop, useConfirm, usePortalRoot, useToast } from "../ui";
import { SearchField } from "./Apps";
import { useDesktop } from "../desktop/Desktop";
import { openTerminalWith } from "../terminalEvent";
import { actionsForItems, asFileSearch, batchToast, copyTextOrToast, FILES_LIST_PAGE, filesListMoreLeft, filesPathToStore, nice, offersDownload, readStoredFilesPath, searchMatchNote, selectionAfterQuery, viewerAfterPathChange, type BatchKind } from "./filesRules";
import { canSubmitNamePrompt, collectUploadDirs, type DirectoryHandleLike, type FavoriteItem, favoritePath, fileKindLabel, filterUnsyncedPhotos, folderPickerRoots, handleFileDragEnter, handleFileDragOver, handleFileDrop, isServedFilePlace, pickDirectoryFromWindow, readDirectoryHandle, readDroppedEntries, reduceUploadMkdir, sharePasswordAction, sharePasswordLabel, shouldActivateRowOnKey, showFolderEmpty, UPLOAD_REFRESH_KEYS, uploadRelBlocked, type UploadBatch, type UploadMkdirState } from "../filesHelpers";

const FileViewer = lazy(() =>
  import("./viewer/FileViewer").then((m) => ({ default: m.FileViewer })),
);

// ---- helpers --------------------------------------------------------------------
const isDir = (f: FileEntry) => f.type === "directory";
// A pipe or socket is not a file. serveFile refuses it; the row must not offer Download or View.
const offersFile = (f: FileEntry) =>
  (f.operations as readonly string[]).includes("download");
const enc = encodeURIComponent;
export const viewUrl = (path: string) => `/api/files/view?path=${enc(path)}`;
export const downloadUrl = (paths: string[]) =>
  `/api/files/download?${paths.map((p) => `path=${enc(p)}`).join("&")}`;
const thumbUrl = (f: FileEntry) =>
  f.thumbnail
    ? `/api/files/thumbnail/${enc(f.thumbnail)}?path=${enc(f.path)}`
    : null;
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const ext = (name: string) =>
  name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

type Kind =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "sheet"
  | "doc"
  | "zip"
  | "disc"
  | "file";
function kindOf(f: FileEntry): Kind {
  if (isDir(f)) return "folder";
  const t = f.type;
  const e = ext(f.name);
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "application/pdf") return "pdf";
  if (
    t.startsWith("text/") ||
    [
      "md",
      "json",
      "yml",
      "yaml",
      "log",
      "conf",
      "sh",
      "js",
      "ts",
      "py",
      "csv",
      "env",
      "toml",
      "ini",
      "xml",
    ].includes(e)
  )
    return "text";
  if (
    /spreadsheet|excel|csv/.test(t) ||
    ["xlsx", "xls", "numbers", "ods"].includes(e)
  )
    return "sheet";
  if (
    /word|document|rtf/.test(t) ||
    ["doc", "docx", "pages", "odt"].includes(e)
  )
    return "doc";
  if (
    /zip|tar|gzip|7z|rar|compressed/.test(t) ||
    ["zip", "gz", "tgz", "tar", "7z", "rar", "xz"].includes(e)
  )
    return "zip";
  if (
    /iso9660|disk-image/.test(t) ||
    ["iso", "img", "qcow2", "dmg"].includes(e)
  )
    return "disc";
  return "file";
}
const KIND_LOOK: Record<Kind, { icon: IconName; color: string }> = {
  folder: { icon: "folder-filled", color: "#60a5fa" },
  image: { icon: "image", color: "#f472b6" },
  video: { icon: "video", color: "#c084fc" },
  audio: { icon: "music", color: "#fb923c" },
  pdf: { icon: "pdf", color: "#f87171" },
  text: { icon: "file-text", color: "#a1a1aa" },
  sheet: { icon: "sheet", color: "#4ade80" },
  doc: { icon: "doc", color: "#60a5fa" },
  zip: { icon: "zip", color: "#facc15" },
  disc: { icon: "disc", color: "#2dd4bf" },
  file: { icon: "file", color: "#a1a1aa" },
};
const ago = (t: number) => {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      new Date(t).getFullYear() === new Date().getFullYear()
        ? undefined
        : "numeric",
  });
};
const PLACE_NAMES: Record<string, string> = {
  "/Home": "Home",
  "/Apps": "App data",
  "/External": "External drives",
  "/Network": "Network",
  "/Trash": "Trash",
  "/Backups": "Backups",
  "/Machines": "Machines",
};
// Photos synced from your phone or computer live here (a normal folder in Home).
const PHOTOS = "/Home/Photos";
const titleOf = (path: string) => PLACE_NAMES[path] ?? baseName(path);

function FileIcon({ f, size = 44 }: { f: FileEntry; size?: number }) {
  const [failed, setFailed] = useState(false);
  const k = kindOf(f);
  const look = KIND_LOOK[k];
  const thumb = thumbUrl(f);
  if (thumb && !failed)
    return (
      <span className="file-icon thumb" style={{ width: size, height: size }}>
        <img
          src={thumb}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          draggable={false}
        />
      </span>
    );
  return (
    <span
      className="file-icon"
      style={{ width: size, height: size, "--c": look.color } as CSSProperties}
    >
      <Icon name={look.icon} size={size * 0.52} stroke={1.6} />
    </span>
  );
}

// ---- data ---------------------------------------------------------------------------
function useListing(path: string | null, sort: "name" | "modified" | "size", limit?: number) {
  return useQuery({
    queryKey: ["files.list", path, sort, limit ?? 0],
    queryFn: () =>
      query<Listing>("files.list", {
        path,
        sortBy: sort,
        sortOrder: sort === "name" ? "ascending" : "descending",
        ...(limit ? { limit } : {}),
      }),
    enabled: !!path && !path.startsWith("::"),
    refetchInterval: 15_000,
  });
}

function useFileAction() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (path: string, input: unknown, done?: string) => {
    try {
      const result = await mutate(path, input);
      if (done) toast(done);
      return result;
    } catch (e) {
      toast(nice((e as Error).message), true);
      throw e;
    } finally {
      qc.invalidateQueries({ queryKey: ["files.list"] });
      qc.invalidateQueries({ queryKey: ["files.favorites"] });
      qc.invalidateQueries({ queryKey: ["files.recents"] });
      qc.invalidateQueries({ queryKey: ["files.shares"] });
      qc.invalidateQueries({ queryKey: ["files.search"] });
    }
  };
}

// ---- uploads ----------------------------------------------------------------------------
type Upload = {
  id: number;
  name: string;
  loaded: number;
  total: number;
  state: "uploading" | "done" | "error";
  error?: string;
};
// An upload item: a file plus, for folder uploads, its path inside the dropped/picked folder.
export type UploadItem = { file: File; rel?: string };

function uploadOne(
  item: UploadItem,
  dir: string,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const target = `${dir}/${item.rel ?? item.file.name}`;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/files/upload?path=${enc(target)}&collision=keep-both`);
    xhr.setRequestHeader("x-omarchy-server", "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status})`;
      try {
        message = JSON.parse(xhr.responseText)?.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Connection lost"));
    xhr.send(item.file);
  });
}

function useUploads(onDone: () => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const toast = useToast();
  const start = async (input: FileList | File[] | UploadItem[] | UploadBatch, dir: string) => {
    const raw = "dirs" in input ? input.files : input;
    const extraDirs = "dirs" in input ? input.dirs : [];
    const items: UploadItem[] = Array.from(raw as ArrayLike<File | UploadItem>).map((x) =>
      x instanceof File
        ? { file: x, rel: (x as File & { webkitRelativePath?: string }).webkitRelativePath || undefined }
        : x,
    );
    const dirs = collectUploadDirs(items, extraDirs);
    if (!items.length && !dirs.length) return;
    haptic(8);
    const ids = items.map(() => Math.random());
    if (items.length) {
      setUploads((u) => [
        ...u,
        ...items.map((it, i) => ({
          id: ids[i],
          name: it.rel ?? it.file.name,
          loaded: 0,
          total: it.file.size,
          state: "uploading" as const,
        })),
      ]);
    }
    // Folder uploads: make the folders first (parents before children). One that already
    // exists is fine. Any other mkdir error is shown once; files under that folder are not
    // uploaded, so a permission error is not reported again as "no longer exists".
    let mkdirState: UploadMkdirState = { failed: [], shown: false };
    for (const d of dirs) {
      if (mkdirState.failed.some((f) => d === f || d.startsWith(`${f}/`))) continue;
      let message: string | null = null;
      try {
        await mutate("files.createDirectory", { path: `${dir}/${d}` });
      } catch (e) {
        message = (e as Error).message;
      }
      const step = reduceUploadMkdir(mkdirState, d, message);
      mkdirState = { failed: step.failed, shown: step.shown };
      if (step.toast) toast(`${d}: ${nice(step.toast)}`, true);
    }
    const dirFailed = mkdirState.failed.length > 0;
    if (!items.length) {
      onDone();
      if (!dirFailed) toast(dirs.length === 1 ? "Folder created" : `${dirs.length} folders created`);
      return;
    }
    // Three at a time, so a folder of hundreds of files doesn't swamp the connection.
    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (next < items.length) {
        const i = next++;
        const it = items[i];
        if (uploadRelBlocked(it.rel, mkdirState.failed)) {
          setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, state: "error", error: "Skipped" } : x)));
          continue;
        }
        try {
          await uploadOne(it, dir, (loaded) =>
            setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, loaded } : x))),
          );
          setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, state: "done", loaded: x.total } : x)));
        } catch (e) {
          failed++;
          setUploads((u) => u.map((x) => (x.id === ids[i] ? { ...x, state: "error", error: (e as Error).message } : x)));
          if (failed <= 3) toast(`${it.rel ?? it.file.name}: ${nice((e as Error).message)}`, true);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
    onDone();
    if (failed > 3) toast(`${failed} files didn’t upload`, true);
    window.setTimeout(() => setUploads((u) => (u.some((x) => x.state !== "done") ? u : [])), 2500);
  };
  const clear = () => setUploads((u) => u.filter((x) => x.state === "uploading"));
  return { uploads, start, clear };
}

// Files and folders dropped from the computer. Folders are walked so their structure is kept.
async function droppedItems(dt: DataTransfer): Promise<UploadBatch> {
  const entries = [...dt.items]
    .map((i) => (i.kind === "file" ? (i as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() : null))
    .filter(Boolean) as FileSystemEntry[];
  if (!entries.length) return { files: [...dt.files].map((file) => ({ file })), dirs: [] };
  return readDroppedEntries(entries);
}

// ---- screen -----------------------------------------------------------------------------
type Place = {
  path: string;
  label: string;
  icon: IconName;
  color: string;
  sub?: string;
};

export function Files({ initialPath, windowId }: { initialPath?: string; windowId?: string } = {}) {
  const portalRoot = usePortalRoot();
  const boot = useBootstrap();
  const user = useUser();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const act = useFileAction();
  const disk = useDisk();
  const [nav, setNav] = useState(() => {
    const start = readStoredFilesPath(windowId, initialPath, (key) => sessionStorage.getItem(key));
    return {entries: [start] as (string | null)[], index: 0};
  });
  const path = nav.entries[nav.index] ?? null;
  const [listLimit, setListLimit] = useState(FILES_LIST_PAGE);
  const [sort, setSort] = useState<"name" | "modified" | "size">("name");
  const [grid, setGrid] = useState(
    () => localStorage.getItem("omarchy-server:files-grid") === "1",
  );
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<FileEntry | null>(null);
  // The full-window viewer: the files you can step through, and where you started.
  const [viewing, setViewing] = useState<{ files: FileEntry[]; index: number } | null>(null);
  const [picker, setPicker] = useState<{
    mode: "move" | "copy";
    paths: string[];
  } | null>(null);
  const [prompt, setPrompt] = useState<{
    kind: "folder" | "rename";
    entry?: FileEntry;
  } | null>(null);
  // The folder whose network sharing is open (share it, or see and change how it's shared).
  const [shareFor, setShareFor] = useState<{ path: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const rowApi = useRef({
    activate: (_f: FileEntry) => {},
    download: (_paths: string[]) => {},
    more: (_f: FileEntry) => {},
    menu: (_f: FileEntry) => {},
    long: (_f: FileEntry) => {},
  });
  const onRowActivate = useCallback((f: FileEntry) => rowApi.current.activate(f), []);
  const onRowDownload = useCallback((f: FileEntry) => rowApi.current.download([f.path]), []);
  const onRowMore = useCallback((f: FileEntry) => rowApi.current.more(f), []);
  const onRowMenu = useCallback((f: FileEntry) => rowApi.current.menu(f), []);
  const onRowLong = useCallback((f: FileEntry) => rowApi.current.long(f), []);
  const refresh = () => {
    for (const key of UPLOAD_REFRESH_KEYS) qc.invalidateQueries({ queryKey: [...key] });
    qc.invalidateQueries({ queryKey: ["files.search"] });
  };
  const { uploads, start: upload, clear: clearUploads } = useUploads(refresh);

  useEffect(() => {
    const stored = filesPathToStore(windowId, path);
    if (stored.value === null) sessionStorage.removeItem(stored.key);
    else sessionStorage.setItem(stored.key, stored.value);
    setSelected(new Set());
    setListLimit(FILES_LIST_PAGE);
  }, [path, windowId]);
  // A new search hides the previous rows, so a selection from that folder must not stay live.
  // The same query (a folder refresh) keeps the selection.
  const seenQuery = useRef(q);
  useEffect(() => {
    const previous = seenQuery.current;
    seenQuery.current = q;
    setSelected((current) => selectionAfterQuery(current, previous, q));
  }, [q]);

  const listing = useListing(path, sort, listLimit);
  const searchPath =
    path && (path === "/Home" || path === "/Trash" || path.startsWith("/Home/") || path.startsWith("/Trash/"))
      ? path
      : "/Home";
  const recents = useQuery({
    queryKey: ["files.recents"],
    queryFn: () => query<FileEntry[]>("files.recents"),
    enabled: path === SERVER_FILES || path === "::recents",
  });
  const favorites = useQuery({
    queryKey: ["files.favorites"],
    queryFn: () => query<FavoriteItem[]>("files.favorites"),
  });
  const owner = user.data != null && user.data.role !== "member";
  const swarm = useQuery({
    queryKey: ["swarm.list"],
    queryFn: () => query<{ id: string; name: string; online: boolean; allowed?: { files?: boolean }; on?: { files?: boolean } }[]>("swarm.list"),
    enabled: owner,
    refetchInterval: 3000,
  });
  const computerFiles = filePlaces(
    (swarm.data ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      online: a.online,
      filesGranted: !!(a.allowed?.files && a.on?.files),
    })),
  );
  const shares = useQuery({
    queryKey: ["files.shares"],
    queryFn: () => query<SmbShare[]>("files.shares"),
    retry: false,
    enabled: owner,
  });
  const search = useQuery({
    queryKey: ["files.search", q, searchPath],
    queryFn: () =>
      query<FileEntry[] | { files: FileEntry[]; truncated?: boolean }>("files.search", {
        query: q,
        maxResults: 100,
        path: searchPath,
      }),
    enabled: q.trim().length >= 2,
    staleTime: 10_000,
  });
  const found = asFileSearch(search.data);
  const favSet = useMemo(() => new Set((favorites.data ?? []).map(favoritePath)), [favorites.data]);
  const shareMap = useMemo(
    () => new Map((shares.data ?? []).map((s) => [s.path, s])),
    [shares.data],
  );

  const go = (p: string | null, how: "push" | "replace" = "push") => {
    haptic(5);
    setQ("");
    scrollPhoneToTop();
    setNav((n) => {
      if (how === "replace") {
        const entries = n.entries.slice(0, n.index);
        entries.push(p);
        return {entries, index: entries.length - 1};
      }
      const base = n.entries.slice(0, n.index + 1);
      if (base[base.length - 1] === p) return n;
      return {entries: [...base, p], index: base.length};
    });
  };
  const up = () => {
    if (!path) return;
    // No history yet, so Back walks up. Replacing keeps the next Back moving upward.
    go(filesParent(path), "replace");
  };
  const back = () => {
    if (nav.index > 0) {
      haptic(5);
      setQ("");
      scrollPhoneToTop();
      setNav((n) => ({...n, index: n.index > 0 ? n.index - 1 : 0}));
      return;
    }
    up();
  };
  const forward = () => {
    if (nav.index >= nav.entries.length - 1) return;
    haptic(5);
    setQ("");
    scrollPhoneToTop();
    setNav((n) => ({...n, index: Math.min(n.entries.length - 1, n.index + 1)}));
  };
  const inTrash = !!path && (path === "/Trash" || path.startsWith("/Trash/"));
  const selecting = selected.size > 0;
  // Where uploads go: the folder you're in (if Omarchy Server says it's writable), or Home from the start page.
  const writableHere =
    !!path && !path.startsWith("::") && !inTrash && listing.data?.operations?.includes("writable") !== false && !listing.error;
  const uploadDir = path === SERVER_FILES ? "/Home" : writableHere ? path : null;
  const canUpload = !!uploadDir;
  const finePointer = typeof matchMedia !== "undefined" && matchMedia("(pointer: fine)").matches;
  // iPhone/iPad Safari can't pick a whole folder; computers can.
  const canPickFolder = finePointer && ("showDirectoryPicker" in window || "webkitdirectory" in HTMLInputElement.prototype);
  const pickFolder = async () => {
    if (!uploadDir) return;
    const win = window as Window & { showDirectoryPicker?: () => Promise<DirectoryHandleLike> };
    if (!win.showDirectoryPicker) return folderInput.current?.click();
    try {
      const handle = await pickDirectoryFromWindow(win);
      if (!handle) return;
      const batch = await readDirectoryHandle(handle);
      if (batch.files.length || batch.dirs.length) upload(batch, uploadDir);
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, true);
    }
  };
  const toggle = (f: FileEntry) => {
    haptic(6);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(f.path)) n.delete(f.path);
      else n.add(f.path);
      return n;
    });
  };
  const activate = (f: FileEntry) => {
    if (selecting) return toggle(f);
    if (isDir(f)) return go(f.path);
    haptic(6);
    if (inTrash || f.path.startsWith("/Trash/")) return setOpen(f);
    if (!offersFile(f)) return setOpen(f);
    viewFile(f);
  };
  const viewFile = (f: FileEntry) => {
    const files = items.filter((x) => !isDir(x));
    const index = files.findIndex((x) => x.path === f.path);
    setViewing(index < 0 ? { files: [f], index: 0 } : { files, index });
  };

  const places: Place[] = [
    { path: "/Home", label: "Home", icon: "home", color: "#3b82f6" },
    { path: PHOTOS, label: "Photos", icon: "image", color: "#ec4899" },
    { path: "::recents", label: "Recents", icon: "history", color: "#f59e0b" },
    { path: "::favorites", label: "Favorites", icon: "star", color: "#eab308" },
    { path: "/Apps", label: "App data", icon: "apps", color: "#8b5cf6" },
    { path: "/External", label: "Drives", icon: "usb", color: "#14b8a6" },
    { path: "/Network", label: "Network", icon: "server", color: "#0ea5e9" },
    { path: "/Trash", label: "Trash", icon: "trash", color: "#71717a" },
  ];
  const computerHere = path ? parseComputerPlace(path) : null;
  const computerName = computerHere ? (swarm.data?.find((a) => a.id === computerHere.id)?.name ?? "Computer") : "";

  // Items shown in the current view.
  const items: FileEntry[] =
    q.trim().length >= 2
      ? found.files
      : path === "::recents"
        ? (recents.data ?? [])
        : path === "::favorites"
          ? (favorites.data ?? []).map(
              (p) =>
                (typeof p === "string" ? {
                  name: baseName(p) || p,
                  path: p,
                  type: "directory",
                  modified: 0,
                  operations: ["favorite"],
                } : p) as FileEntry,
            )
          : (listing.data?.files ?? []);
  const folderListing = !!path && !path.startsWith("::") && q.trim().length < 2;
  const activeQ =
    q.trim().length >= 2
      ? search
      : path === "::recents"
        ? recents
        : path === "::favorites"
          ? favorites
          : listing;
  const browserOnline = useBrowserOnline();
  const fileProblem = path !== null || q ? queryProblem(activeQ, browserOnline) : null;
  const showEmpty = showFolderEmpty({
    error: folderListing ? listing.error : activeQ.error,
    count: items.length,
    suppress: fileProblem != null && activeQ.data == null,
  });
  const loading =
    q.trim().length >= 2
      ? search.isLoading
      : path === "::recents"
        ? recents.isLoading
        : path && !path.startsWith("::")
          ? listing.isLoading
          : false;

  const finishBatch = async (
    paths: string[],
    kind: BatchKind,
    run: (p: string) => Promise<unknown>,
  ) => {
    let succeeded = 0;
    for (const p of paths) {
      try {
        await run(p);
        succeeded++;
      } catch {
        // useFileAction already showed this call's error.
      }
    }
    const message = batchToast(succeeded, paths.length - succeeded, kind);
    if (message) toast(message);
    setSelected(new Set());
    setOpen(null);
  };
  const trashItems = async (paths: string[]) => {
    const ok = await confirm({
      title:
        paths.length === 1
          ? `Move “${baseName(paths[0])}” to Trash?`
          : `Move ${paths.length} items to Trash?`,
      body: "You can restore them from Trash later.",
      confirm: "Move to Trash",
      danger: true,
      icon: "trash",
    });
    if (!ok) return;
    await finishBatch(paths, "trash", async (p) => {
      await act("files.trash", { path: p });
      setViewing((v) => viewerAfterPathChange(v, p, null));
    });
  };
  const deleteForever = async (paths: string[]) => {
    const ok = await confirm({
      title:
        paths.length === 1
          ? `Delete “${baseName(paths[0])}” forever?`
          : `Delete ${paths.length} items forever?`,
      body: "This can’t be undone.",
      confirm: "Delete forever",
      danger: true,
      icon: "trash",
    });
    if (!ok) return;
    await finishBatch(paths, "delete", async (p) => {
      await act("files.delete", { path: p });
      setViewing((v) => viewerAfterPathChange(v, p, null));
    });
  };
  const restore = async (paths: string[]) => {
    await finishBatch(paths, "restore", (p) =>
      act("files.restore", { path: p, collision: "keep-both" }),
    );
  };
  const emptyTrash = async () => {
    if (
      !(await confirm({
        title: "Empty Trash?",
        body: "Everything in Trash is deleted forever.",
        confirm: "Empty Trash",
        danger: true,
        icon: "trash",
      }))
    )
      return;
    await act("files.emptyTrash", undefined, "Trash emptied").catch(() => {});
  };
  const download = (paths: string[]) => {
    haptic(6);
    const a = document.createElement("a");
    a.href = downloadUrl(paths);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(paths.length > 1 ? "Downloading as a zip" : "Downloading");
  };
  const toggleFavorite = (p: string) =>
    act(
      favSet.has(p) ? "files.removeFavorite" : "files.addFavorite",
      { path: p },
      favSet.has(p) ? "Removed from Favorites" : "Added to Favorites",
    );
  const toggleShare = (f: FileEntry) => {
    setOpen(null);
    setShareFor({ path: f.path, name: f.name });
  };
  const used = disk.data ? diskPct(disk.data) / 100 : 0;

  const serverName = boot.server?.device || boot.server?.name || "This server";
  const heading =
    path === null
      ? "Files"
      : computerHere
        ? computerHere.rel.split("/").filter(Boolean).pop() || computerName
        : path === SERVER_FILES
          ? serverName
          : path === "::recents"
            ? "Recents"
            : path === "::favorites"
              ? "Favorites"
              : titleOf(path);
  const crumbs: {name: string; path: string | null}[] = [{name: "Files", path: null}];
  if (path && computerHere) {
    const root = computerPlacePath(computerHere.id);
    if (root) crumbs.push({name: computerName, path: root});
    const parts = computerHere.rel.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const rel = parts.slice(0, i + 1).join("/");
      const next = computerPlacePath(computerHere.id, rel);
      if (next) crumbs.push({name: parts[i], path: next});
    }
  } else if (path) {
    crumbs.push({name: serverName, path: SERVER_FILES});
    if (path === "::recents" || path === "::favorites") crumbs.push({name: heading, path});
    else if (path !== SERVER_FILES && !path.startsWith("::")) {
      const parts = path.split("/").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const p = `/${parts.slice(0, i + 1).join("/")}`;
        crumbs.push({name: titleOf(p), path: p});
      }
    }
  }
  const canBack = nav.index > 0 || path !== null;
  const canForward = nav.index < nav.entries.length - 1;
  const onServer = !!path && !computerHere;
  const machineRoot = path === null && q.trim().length < 2;
  const serverPlacesView = path === SERVER_FILES && q.trim().length < 2;
  const setFileMode = (next: boolean) => {
    haptic(5);
    localStorage.setItem("omarchy-server:files-grid", next ? "1" : "0");
    setGrid(next);
  };
  const rootItems: NuItem[] = [
    {key: "server", name: serverName, modified: "Entrypoint", icon: "server", onOpen: () => go(SERVER_FILES)},
    ...computerFiles.places.map((p) => ({key: p.id, name: p.name, icon: "devices" as const, onOpen: () => go(p.path)})),
  ];
  const placeItems: NuItem[] = places
    .filter((p) => isServedFilePlace(p.path))
    .map((p) => ({
      key: p.path,
      name: p.label,
      icon: p.icon,
      onOpen: () =>
        p.path === PHOTOS
          ? mutate("files.createDirectory", {path: PHOTOS})
              .catch(() => {})
              .finally(() => go(PHOTOS))
          : go(p.path),
    }));
  const bar = (
    <div className="nu-bar">
      <h1 className="sr-only">{heading}</h1>
      <button type="button" className="nu-nav" aria-label="Back" onClick={back} disabled={!canBack}>
        <Icon name="back" size={16} />
      </button>
      <button type="button" className="nu-nav" aria-label="Forward" onClick={forward} disabled={!canForward}>
        <Icon name="chevron" size={16} />
      </button>
      <nav className="nu-path" aria-label="Breadcrumbs">
        <ol>
          {crumbs.map((crumb, i) => {
            const current = i === crumbs.length - 1;
            return (
              <li key={`${crumb.path ?? "files"}-${i}`}>
                <button type="button" aria-current={current ? "page" : undefined} onClick={() => go(crumb.path)}>
                  {crumb.name}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {owner && path && path.startsWith("/Home/") && (
        <button
          className="nu-nav"
          aria-label="Share this folder on your home LAN"
          title="Share on your home LAN"
          aria-pressed={shareMap.has(path)}
          onClick={() => (haptic(5), setShareFor({path, name: titleOf(path)}))}
        >
          <Icon name="folder-share" size={16} />
        </button>
      )}
      {path && !path.startsWith("::") && (
        <button
          type="button"
          className="nu-nav"
          aria-label={`Sort by ${sort === "name" ? "date" : sort === "modified" ? "size" : "name"}`}
          onClick={() => {
            haptic(5);
            const next = sort === "name" ? "modified" : sort === "modified" ? "size" : "name";
            setSort(next);
            toast(`Sorted by ${next === "modified" ? "date" : next}`);
          }}
        >
          <Icon name="sort" size={16} />
        </button>
      )}
      <div className="nu-modes" role="group" aria-label="View">
        <button type="button" aria-label="List" aria-pressed={!grid} onClick={() => setFileMode(false)}>
          <Icon name="list" size={16} />
        </button>
        <button type="button" aria-label="Grid" aria-pressed={grid} onClick={() => setFileMode(true)}>
          <Icon name="grid" size={16} />
        </button>
      </div>
    </div>
  );

  rowApi.current.activate = activate;
  rowApi.current.download = download;
  rowApi.current.more = (f) => {
    haptic(6);
    setOpen(f);
  };
  rowApi.current.menu = (f) => setOpen(f);
  rowApi.current.long = (f) => {
    if (!f.operations.length) return;
    haptic(15);
    setSelected((s) => new Set(s).add(f.path));
  };
  const showParent = q.trim().length >= 2;
  const renderRow = (f: FileEntry) => (
    <FileRow
      key={f.path}
      f={f}
      grid={grid}
      selected={selected.has(f.path)}
      selecting={selecting}
      favorite={favSet.has(f.path)}
      shared={shareMap.has(f.path)}
      inTrash={inTrash}
      showParent={showParent}
      activate={onRowActivate}
      onMore={onRowMore}
      onDownload={onRowDownload}
      onLong={onRowLong}
      onMenu={onRowMenu}
    />
  );

  const onDragEnter = (e: React.DragEvent) => {
    if (!handleFileDragEnter(e, canUpload)) return;
    dragDepth.current++;
    setDropping(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    handleFileDragOver(e, canUpload);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDropping(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    const allowed = handleFileDrop(e, canUpload && !!uploadDir);
    dragDepth.current = 0;
    setDropping(false);
    if (!allowed || !uploadDir) return;
    const batch = await droppedItems(e.dataTransfer).catch((): UploadBatch => ({ files: [], dirs: [] }));
    if (batch.files.length || batch.dirs.length) upload(batch, uploadDir);
  };

  return (
    <div className="stagger files-root nu" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => (
          uploadDir && e.target.files && upload(e.target.files, uploadDir),
          (e.target.value = "")
        )}
      />
      <input
        ref={photoInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          const picked = e.target.files ? [...e.target.files] : [];
          e.target.value = "";
          if (!picked.length) return;
          // Sync: upload only what isn't in Photos yet (same name or keep-both copy, and size).
          const fresh = filterUnsyncedPhotos(picked, listing.data?.files ?? []);
          const skipped = picked.length - fresh.length;
          if (!fresh.length) return toast(`All ${picked.length} already synced`);
          if (skipped) toast(`${fresh.length} new · ${skipped} already synced`);
          upload(fresh, PHOTOS);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(e) => (
          uploadDir && e.target.files && upload(e.target.files, uploadDir),
          (e.target.value = "")
        )}
      />
      {bar}
      <SearchField
        value={q}
        onChange={setQ}
        placeholder={path === null ? "Search all files" : `Search files`}
      />
      {canUpload && !q && !selecting && (
        <div className="files-actions">
          {path === PHOTOS && (
            <button className="btn primary" onClick={() => photoInput.current?.click()} disabled={listing.isLoading}>
              <Icon name="restart" size={18} />
              Sync photos
            </button>
          )}
          <button className={`btn${path === PHOTOS ? "" : " primary"}`} onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={18} />
            {path === SERVER_FILES ? "Upload to Home" : "Upload"}
          </button>
          {canPickFolder && (
            <button className="btn" onClick={pickFolder}>
              <Icon name="folder-share" size={18} />
              Upload folder
            </button>
          )}
          {path && !path.startsWith("::") && (
            <button className="btn" onClick={() => setPrompt({ kind: "folder" })}>
              <Icon name="folder-plus" size={18} />
              New folder
            </button>
          )}
          {finePointer && <span className="drop-hint">or drop files here</span>}
        </div>
      )}

      <div className="nu-body">
        <aside className="nu-side" aria-label="Places">
          <h3>Places</h3>
          <button type="button" className="nu-place" aria-current={path === null ? "page" : undefined} onClick={() => go(null)}>
            <span className="dot" />
            Files
          </button>
          <button type="button" className="nu-place" aria-current={onServer ? "page" : undefined} onClick={() => go(SERVER_FILES)}>
            <span className="dot" />
            {serverName}
          </button>
          {computerFiles.places.map((p) => (
            <button
              key={p.id}
              type="button"
              className="nu-place"
              aria-current={computerHere?.id === p.id ? "page" : undefined}
              onClick={() => go(p.path)}
            >
              <span className="dot" />
              {p.name}
            </button>
          ))}
        </aside>
        <div className="nu-main">
      {machineRoot && (
        <>
          <NuEntries items={rootItems} grid={grid} />
          {computerFiles.note && <p className="reason">{computerFiles.note}</p>}
          <div className="nu-status">
            {rootItems.length} item{rootItems.length === 1 ? "" : "s"}
          </div>
        </>
      )}

      {serverPlacesView && (
        <>
          <NuEntries items={placeItems} grid={grid} />
          {disk.data && (
            <Card className="storage-card">
              <CardHead
                title="Storage"
                extra={
                  <>
                    {bytes(disk.data.available, 0)} free of{" "}
                    {bytes(disk.data.size, 0)}
                  </>
                }
                style={{ marginBottom: 10 }}
              />
              <span className="progress" style={{ height: 8 }}>
                <i
                  style={{
                    width: `${used * 100}%`,
                    background:
                      used > 0.9
                        ? "var(--red)"
                        : used > 0.75
                          ? "var(--yellow)"
                          : "var(--accent-text)",
                  }}
                />
              </span>
            </Card>
          )}
          {(shares.data?.length ?? 0) > 0 && (
            <section>
              <div className="section-head">
                <h2>Shared on your network</h2>
              </div>
              <div
                className="glass group"
                style={{ "--inset": "74px" } as CSSProperties}
              >
                {shares.data!.map((s) => (
                  <button
                    key={s.path}
                    className="row"
                    onClick={() => setShareFor({ path: s.path, name: s.name })}
                  >
                    <span
                      className="file-icon"
                      style={
                        {
                          width: 44,
                          height: 44,
                          "--c": "#0ea5e9",
                        } as CSSProperties
                      }
                    >
                      <Icon name="folder-share" size={23} />
                    </span>
                    <span className="main">
                      <b>{s.name}</b>
                      <span className="mono">
                        {s.available === false
                          ? "Unavailable · this folder is gone"
                          : `smb://${boot.server?.host}/${s.sharename}`}
                      </span>
                    </span>
                    <Icon name="chevron" size={18} className="chev" />
                  </button>
                ))}
              </div>
            </section>
          )}
          {(recents.data?.length ?? 0) > 0 && (
            <section>
              <div className="section-head">
                <h2>Recent</h2>
                <button className="link-btn" onClick={() => go("::recents")}>
                  See all
                </button>
              </div>
              <div
                className="glass group"
                style={{ "--inset": "74px" } as CSSProperties}
              >
                {recents.data!.slice(0, 5).map((f) => renderRow(f))}
              </div>
            </section>
          )}
          <div className="nu-status">
            {placeItems.length} item{placeItems.length === 1 ? "" : "s"}
          </div>
        </>
      )}

      {computerHere && (
        <ComputerFolder
          id={computerHere.id}
          rel={computerHere.rel}
          grid={grid}
          onOpen={(rel) => {
            const next = computerPlacePath(computerHere.id, rel)
            if (next) go(next)
          }}
        />
      )}

      {(path !== null || q) && !computerHere && !serverPlacesView && (
        <>
          {inTrash && (listing.data?.files.length ?? 0) > 0 && !selecting && (
            <button
              className="btn danger block"
              style={{ marginBottom: 12, minHeight: 46 }}
              onClick={emptyTrash}
            >
              <Icon name="trash" size={18} />
              Empty Trash
            </button>
          )}
          {fileProblem && (
            <div className="error" role="alert">
              <Icon name="alert" size={18} />
              {activeQ.error ? nice((activeQ.error as Error).message) : fileProblem}
            </div>
          )}
          {loading ? (
            <div className="glass group">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="row static">
                  <div
                    className="skeleton"
                    style={{ width: 44, height: 44, borderRadius: 12 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      className="skeleton"
                      style={{ width: "55%", height: 12, marginBottom: 8 }}
                    />
                    <div
                      className="skeleton"
                      style={{ width: "30%", height: 10 }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : showEmpty ? (
            <div className="glass empty">
              <span className="big">
                <Icon
                  name={
                    q
                      ? "search"
                      : inTrash
                        ? "trash"
                        : path === "::recents"
                          ? "history"
                          : path === "::favorites"
                            ? "star"
                            : "folder"
                  }
                  size={30}
                />
              </span>
              <b>
                {q
                  ? "No matches"
                  : inTrash
                    ? "Trash is empty"
                    : path === "::recents"
                      ? "No recent files yet"
                      : path === "::favorites"
                        ? "No favorites yet"
                        : "This folder is empty"}
              </b>
              {!q && !inTrash && path && !path.startsWith("::") && (
                <span>Tap + to upload photos or files.</span>
              )}
            </div>
          ) : items.length === 0 ? null : grid && !q ? (
            <div className="file-grid">
              {items.map((f) => renderRow(f))}
            </div>
          ) : (
            <div
              className="glass group"
              style={
                { "--inset": selecting ? "110px" : "74px" } as CSSProperties
              }
            >
              {items.map((f) => renderRow(f))}
            </div>
          )}
          {showParent && searchMatchNote(found.files.length, found.truncated) ? (
            <p className="footer-note">{searchMatchNote(found.files.length, found.truncated)}</p>
          ) : null}
          {folderListing && listing.data?.hasMore ? (
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setListLimit((n) => n + FILES_LIST_PAGE)}>
              Show more ({filesListMoreLeft(listing.data.totalFiles, listing.data.files.length).toLocaleString()} left)
            </button>
          ) : null}
        </>
      )}
        </div>
      </div>

      {createPortal(
        <>
          {dropping && uploadDir && (
            <div className="drop-zone" aria-hidden="true">
              <span>
                <Icon name="upload" size={34} />
                <b>Drop to upload</b>
                <small>to {titleOf(uploadDir)}</small>
              </span>
            </div>
          )}

          {/* Selection bar */}
          {selecting && (
            <div className="select-bar">
              <button
                className="sb-cancel"
                onClick={() => setSelected(new Set())}
              >
                <Icon name="close" size={18} stroke={2.2} />
                <span className="num">{selected.size}</span>
              </button>
              {inTrash ? (
                <>
                  <button onClick={() => restore([...selected])}>
                    <Icon name="restore" size={21} />
                    Restore
                  </button>
                  <button
                    className="danger"
                    onClick={() => deleteForever([...selected])}
                  >
                    <Icon name="trash" size={21} />
                    Delete
                  </button>
                </>
              ) : (
                <>
                  {offersDownload(
                    [...selected].map((p) => {
                      const hit = items.find((it) => it.path === p);
                      return { directory: !hit || isDir(hit) || !offersFile(hit) };
                    }),
                  ) && (
                    <button onClick={() => download([...selected])}>
                      <Icon name="download" size={21} />
                      Download
                    </button>
                  )}
                  <button
                    onClick={() =>
                      setPicker({ mode: "move", paths: [...selected] })
                    }
                  >
                    <Icon name="move" size={21} />
                    Move
                  </button>
                  <button
                    onClick={() =>
                      setPicker({ mode: "copy", paths: [...selected] })
                    }
                  >
                    <Icon name="copy" size={21} />
                    Copy
                  </button>
                  <button
                    className="danger"
                    onClick={() => trashItems([...selected])}
                  >
                    <Icon name="trash" size={21} />
                    Trash
                  </button>
                </>
              )}
            </div>
          )}

          {uploads.length > 0 && (
            <UploadPanel uploads={uploads} onClear={clearUploads} />
          )}
        </>,
        portalRoot,
      )}


      {viewing && (
        <Suspense
          fallback={
            <main className="screen center">
              <span className="spinner" aria-label="Loading" />
            </main>
          }
        >
          <FileViewer
            files={viewing.files}
            index={viewing.index}
            onClose={() => setViewing(null)}
            onInfo={(f) => setOpen(f)}
            onDownload={(f) => download([f.path])}
            onChanged={() => {
              qc.invalidateQueries({ queryKey: ["files.list"] });
              qc.invalidateQueries({ queryKey: ["files.recents"] });
            }}
          />
        </Suspense>
      )}

      {open && (
        <ItemSheet
          f={open}
          onView={viewing ? undefined : () => (setOpen(null), viewFile(open))}
          inTrash={inTrash || open.path.startsWith("/Trash/")}
          favorite={favSet.has(open.path)}
          shared={shareMap.get(open.path)}
          canShare={owner}
          onClose={() => setOpen(null)}
          onOpenFolder={() => (setOpen(null), go(open.path))}
          onDownload={() => download([open.path])}
          onRename={() => setPrompt({ kind: "rename", entry: open })}
          onMove={() => setPicker({ mode: "move", paths: [open.path] })}
          onCopy={() => setPicker({ mode: "copy", paths: [open.path] })}
          onFavorite={() => toggleFavorite(open.path)}
          onShare={() => toggleShare(open)}
          onShareInfo={(s) => (setOpen(null), setShareFor({ path: s.path, name: s.name }))}
          onTrash={() => trashItems([open.path])}
          onRestore={() => restore([open.path])}
          onDelete={() => deleteForever([open.path])}
        />
      )}

      {prompt && (
        <NamePrompt
          title={prompt.kind === "folder" ? "New folder" : "Rename"}
          initial={prompt.kind === "rename" ? prompt.entry!.name : "New folder"}
          submit={prompt.kind === "folder" ? "Create" : "Rename"}
          selectStem={prompt.kind === "rename" && !isDir(prompt.entry!)}
          requireChange={prompt.kind === "rename"}
          onClose={() => setPrompt(null)}
          onSubmit={async (name) => {
            if (prompt.kind === "folder")
              await act(
                "files.createDirectory",
                { path: `${path}/${name}` },
                "Folder created",
              );
            else {
              const from = prompt.entry!.path;
              const next = await act(
                "files.rename",
                { path: from, newName: name },
                "Renamed",
              );
              setViewing((v) => viewerAfterPathChange(v, from, typeof next === "string" ? next : null));
              setOpen(null);
            }
            setPrompt(null);
          }}
        />
      )}

      {picker && (
        <FolderPicker
          mode={picker.mode}
          count={picker.paths.length}
          start={path && !path.startsWith("::") && !inTrash ? path : "/Home"}
          exclude={picker.paths}
          onClose={() => setPicker(null)}
          onPick={async (dir) => {
            const verb = picker.mode === "move" ? "files.move" : "files.copy";
            let ok = 0;
            for (const p of picker.paths) {
              if (parentOf(p) === dir && picker.mode === "move") continue;
              try {
                const next = await act(verb, {
                  path: p,
                  toDirectory: dir,
                  collision: "keep-both",
                });
                if (picker.mode === "move")
                  setViewing((v) => viewerAfterPathChange(v, p, typeof next === "string" ? next : null));
                ok++;
              } catch {
                // useFileAction already showed this call's error.
              }
            }
            if (ok)
              toast(
                `${ok === 1 ? "1 item" : `${ok} items`} ${picker.mode === "move" ? "moved" : "copied"} to ${titleOf(dir)}`,
              );
            setPicker(null);
            setSelected(new Set());
            setOpen(null);
          }}
        />
      )}

      {shareFor && (
        <ShareSheet
          path={shareFor.path}
          name={shareFor.name}
          host={boot.server?.host ?? ""}
          username={user.data?.sambaUsername}
          onClose={() => setShareFor(null)}
        />
      )}
    </div>
  );
}

// ---- long press -----------------------------------------------------------------------
function useLongPress(onLong: (f: FileEntry) => void, onMenu?: (f: FileEntry) => void) {
  const t = useRef<number>();
  const menu = useRef(onMenu);
  menu.current = onMenu;
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cb = useRef(onLong);
  cb.current = onLong;
  return (f: FileEntry) => ({
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(t.current);
      t.current = window.setTimeout(() => {
        fired.current = true;
        cb.current(f);
      }, 480);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (
        start.current &&
        Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) >
          10
      )
        window.clearTimeout(t.current);
    },
    onPointerUp: () => window.clearTimeout(t.current),
    onPointerCancel: () => window.clearTimeout(t.current),
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        e.stopPropagation();
        e.preventDefault();
        fired.current = false;
      }
    },
    // Right-click (or a long press the browser reports as one): this item's actions.
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      window.clearTimeout(t.current);
      if (menu.current && !fired.current) menu.current(f);
    },
  });
}

const FileRow = memo(function FileRow({
  f,
  grid,
  selected,
  selecting,
  favorite,
  shared,
  inTrash,
  showParent,
  activate,
  onMore,
  onDownload,
  onLong,
  onMenu,
}: {
  f: FileEntry;
  grid: boolean;
  selected: boolean;
  selecting: boolean;
  favorite: boolean;
  shared: boolean;
  inTrash: boolean;
  showParent: boolean;
  activate: (f: FileEntry) => void;
  onMore: (f: FileEntry) => void;
  onDownload: (f: FileEntry) => void;
  onLong: (f: FileEntry) => void;
  onMenu: (f: FileEntry) => void;
}) {
  const press = useLongPress(onLong, onMenu);
  const sub = isDir(f)
    ? f.modified
      ? `Folder · ${ago(f.modified)}`
      : "Folder"
    : `${bytes(f.size)} · ${ago(f.modified)}`;
  if (grid)
    return (
      <button className={`file-tile${selected ? " sel" : ""}`} onClick={() => activate(f)} {...press(f)}>
        <span className="tile-art">
          <FileIcon f={f} size={isDir(f) ? 64 : 92} />
          {selecting && <Icon name={selected ? "checked" : "unchecked"} size={22} className="tile-check" />}
        </span>
        <span className="name">{f.name}</span>
        <span className="sub">{isDir(f) ? "Folder" : bytes(f.size)}</span>
      </button>
    );
  return (
    <div
      className={`row file-row${selected ? " sel" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => activate(f)}
      onKeyDown={(e) => shouldActivateRowOnKey(e) && activate(f)}
      {...press(f)}
    >
      {selecting && <Icon name={selected ? "checked" : "unchecked"} size={24} className={`check${selected ? " on" : ""}`} />}
      <FileIcon f={f} />
      <span className="main">
        <b>
          {f.name}
          {favorite && <Icon name="star-filled" size={13} className="fav" />}
          {shared && <Icon name="folder-share" size={14} className="shared" />}
        </b>
        <span>{showParent ? parentOf(f.path) : sub}</span>
      </span>
      {!selecting && !inTrash && !f.path.startsWith("/Trash/") && offersDownload([{ directory: isDir(f) }]) && offersFile(f) && (
        <button
          className="icon-btn row-dl"
          style={{ alignSelf: "center" }}
          aria-label={`Download ${f.name}`}
          title="Download"
          onClick={(e) => {
            e.stopPropagation();
            onDownload(f);
          }}
        >
          <Icon name="download" size={18} />
        </button>
      )}
      {!selecting && (
        <button
          className="icon-btn"
          style={{ alignSelf: "center", background: "transparent" }}
          aria-label={`More for ${f.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onMore(f);
          }}
        >
          <Icon name="dots" size={18} />
        </button>
      )}
    </div>
  );
});

// ---- item sheet with preview ---------------------------------------------------------------
function ItemSheet(p: {
  f: FileEntry;
  inTrash: boolean;
  favorite: boolean;
  shared?: SmbShare;
  canShare?: boolean;
  onClose: () => void;
  onOpenFolder: () => void;
  onView?: () => void;
  onDownload: () => void;
  onRename: () => void;
  onMove: () => void;
  onCopy: () => void;
  onFavorite: () => void;
  onShare: () => void;
  onShareInfo: (s: SmbShare) => void;
  onTrash: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const desk = useDesktop();
  const { f } = p;
  const toast = useToast();
  const qc = useQueryClient();
  const k = kindOf(f);
  const can = (op: FileEntry["operations"][number]) =>
    f.operations.includes(op);
  const shareOut = async () => {
    haptic(6);
    try {
      if (!isDir(f) && navigator.canShare && (f.size ?? 0) < 200e6) {
        const blob = await fetch(downloadUrl([f.path]), {
          credentials: "same-origin",
        }).then((r) => {
          if (!r.ok) throw new Error("Couldn’t load the file");
          return r.blob();
        });
        const file = new File([blob], f.name, {
          type: f.type === "directory" ? "application/zip" : f.type,
        });
        if (navigator.canShare({ files: [file] }))
          return void (await navigator.share({ files: [file], title: f.name }));
      }
      p.onDownload();
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast((e as Error).message, true);
    }
  };
  type A = {
    id: string;
    label: string;
    icon: IconName;
    onClick: () => void;
    show: boolean;
    danger?: boolean;
  };
  const actions: A[] = p.inTrash
    ? [
        {
          id: "restore",
          label: "Restore",
          icon: "restore",
          onClick: p.onRestore,
          show: true,
        },
        {
          id: "delete",
          label: "Delete",
          icon: "trash",
          onClick: p.onDelete,
          show: true,
          danger: true,
        },
      ]
    : [
        {
          id: "download-zip",
          label: "Download zip",
          icon: "download",
          onClick: p.onDownload,
          show: isDir(f),
        },
        {
          id: "share-out",
          label: "Share",
          icon: "share",
          onClick: shareOut,
          show: !isDir(f),
        },
        {
          id: "download",
          label: "Download",
          icon: "download",
          onClick: p.onDownload,
          show: offersFile(f),
        },
        {
          id: "clip",
          label: "Clip book",
          icon: "clipboard",
          onClick: () => {
            mutate("clips.addFile", { scope: "server", path: f.path })
              .then(() => {
                toast("Saved to the clip book");
                qc.invalidateQueries({ queryKey: ["clips.list"] });
              })
              .catch((e: Error) => toast(e.message, true));
          },
          show: offersFile(f) && !f.path.startsWith("/Trash/"),
        },
        {
          id: "rename",
          label: "Rename",
          icon: "pencil",
          onClick: p.onRename,
          show: can("rename"),
        },
        {
          id: "move",
          label: "Move",
          icon: "move",
          onClick: p.onMove,
          show: can("move"),
        },
        {
          id: "copy",
          label: "Copy",
          icon: "copy",
          onClick: p.onCopy,
          show: can("copy"),
        },
        {
          id: "fav",
          label: p.favorite ? "Unfavorite" : "Favorite",
          icon: p.favorite ? "star-filled" : "star",
          onClick: p.onFavorite,
          show: can("favorite") || p.favorite,
        },
        {
          id: "smb",
          label: p.shared ? "Unshare" : "Network share",
          icon: "folder-share",
          onClick: p.onShare,
          show: !!p.canShare && isDir(f) && (can("share") || !!p.shared),
        },
        {
          id: "desk",
          label: "Add to desktop",
          icon: "plus",
          onClick: () => {
            desk?.addIcon(`folder:${f.path}`);
            toast(`${f.name} added to the desktop`);
          },
          show: !!desk && isDir(f),
        },
      ];
  const shown = actionsForItems(
    actions.filter((a) => a.show),
    [{ directory: isDir(f) }],
  );
  return (
    <Sheet open onClose={p.onClose} label={f.name}>
      <SheetHeader
        icon={<FileIcon f={f} size={52} />}
        title={f.name}
        subtitle={isDir(f) ? "Folder" : `${bytes(f.size)} · ${ago(f.modified)}`}
        onClose={p.onClose}
      />
      {!p.inTrash && offersFile(f) && <Preview f={f} kind={k} />}
      {!isDir(f) && !p.inTrash && p.onView && (
        <div className="primary-row">
          <button className="btn primary" onClick={p.onView}>
            <Icon name="eye" size={20} />
            Open
          </button>
        </div>
      )}
      {isDir(f) && !p.inTrash && (
        <div className="primary-row">
          <button className="btn primary" onClick={p.onOpenFolder}>
            <Icon name="folder" size={20} />
            Open folder
          </button>
        </div>
      )}
      {p.canShare && p.shared && (
        <button
          className="glass card press share-chip"
          onClick={() => p.onShareInfo(p.shared!)}
        >
          <Icon name="folder-share" size={20} />
          <span>
            Shared as <b>{p.shared.sharename}</b> on your home LAN
          </span>
          <Icon name="chevron" size={16} className="muted" />
        </button>
      )}
      <div
        className="actions"
        style={{
          gridTemplateColumns: `repeat(${Math.min(4, shown.length)}, minmax(0, 1fr))`,
        }}
      >
        {shown.map((a) => (
          <button
            key={a.id}
            className={`action${a.danger ? " danger-action" : ""}`}
            onClick={a.onClick}
          >
            <Icon name={a.icon} size={22} />
            {a.label}
          </button>
        ))}
      </div>
      <div className="kv glass group" style={{ borderRadius: 18 }}>
        <div className="row static">
          <span className="k">Where</span>
          <span className="v">{parentOf(f.path)}</span>
        </div>
        {!isDir(f) && (
          <div className="row static">
            <span className="k">Kind</span>
            <span className="v">{fileKindLabel(f)}</span>
          </div>
        )}
        {f.modified ? (
          <div className="row static">
            <span className="k">Modified</span>
            <span className="v">
              {new Date(f.modified).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </span>
          </div>
        ) : null}
      </div>
      {!p.inTrash && can("trash") && (
        <button className="btn danger block" onClick={p.onTrash}>
          <Icon name="trash" size={19} />
          Move to Trash
        </button>
      )}
    </Sheet>
  );
}

function Preview({ f, kind }: { f: FileEntry; kind: Kind }) {
  const [text, setText] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (kind !== "text" || (f.size ?? 0) > 512_000) return;
    fetch(viewUrl(f.path), { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then(setText, () => setText(null));
  }, [f.path, f.size, kind]);
  let body: ReactNode = null;
  if (kind === "image")
    body = (
      <button
        className="preview-img"
        onClick={() => setFull(true)}
        aria-label="View full screen"
      >
        <img src={viewUrl(f.path)} alt={f.name} />
      </button>
    );
  else if (kind === "video")
    body = (
      <video
        className="preview-media"
        src={viewUrl(f.path)}
        controls
        playsInline
        preload="metadata"
      />
    );
  else if (kind === "audio")
    body = (
      <audio
        className="preview-audio"
        src={viewUrl(f.path)}
        controls
        preload="metadata"
      />
    );
  else if (kind === "pdf")
    body = (
      <iframe
        className="preview-pdf"
        title={f.name}
        src={viewUrl(f.path)}
        sandbox=""
      />
    );
  else if (kind === "text" && text !== null)
    body = <pre className="preview-text">{text.slice(0, 20_000)}</pre>;
  if (!body) return null;
  return (
    <>
      <div className="preview">{body}</div>
      {full && (
        <Sheet open onClose={() => setFull(false)} label={f.name} tall>
          <SheetHeader title={f.name} onClose={() => setFull(false)} />
          <div className="zoom-view">
            <img src={viewUrl(f.path)} alt={f.name} />
          </div>
        </Sheet>
      )}
    </>
  );
}

// ---- name prompt -----------------------------------------------------------------------------
function NamePrompt({
  title,
  initial,
  submit,
  selectStem,
  requireChange,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: string;
  submit: string;
  selectStem?: boolean;
  requireChange?: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);
  const canSubmit = canSubmitNamePrompt({ name, initial, requireChange, busy });
  return (
    <Sheet open onClose={onClose} label={title}>
      <SheetHeader title={title} onClose={onClose} />
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!canSubmit) return;
          setBusy(true);
          await onSubmit(name.trim()).catch(() => {});
          setBusy(false);
        }}
      >
        <div className="field">
          <label htmlFor="fname" className="sr-only">
            Name
          </label>
          <input
            id="fname"
            ref={ref}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <button
          className="btn primary block"
          disabled={!canSubmit}
        >
          {busy && <span className="spinner" />}
          {submit}
        </button>
      </form>
    </Sheet>
  );
}

// ---- folder picker (move / copy) ---------------------------------------------------------------------
function FolderPicker({
  mode,
  count,
  start,
  exclude,
  onClose,
  onPick,
}: {
  mode: "move" | "copy";
  count: number;
  start: string;
  exclude: string[];
  onClose: () => void;
  onPick: (dir: string) => Promise<void>;
}) {
  const [dir, setDir] = useState(start);
  const [busy, setBusy] = useState(false);
  const listing = useListing(dir, "name");
  const folders = (listing.data?.files ?? []).filter(
    (f) => isDir(f) && !exclude.includes(f.path),
  );
  const blocked = exclude.some((p) => dir === p || dir.startsWith(`${p}/`));
  const roots = folderPickerRoots();
  return (
    <Sheet
      open
      onClose={onClose}
      label={mode === "move" ? "Move to" : "Copy to"}
      tall
    >
      <SheetHeader
        title={`${mode === "move" ? "Move" : "Copy"} ${count === 1 ? "1 item" : `${count} items`}`}
        subtitle={`to ${dir}`}
        onClose={onClose}
      />
      <div className="chips" style={{ marginBottom: 10 }}>
        {roots.map((r) => (
          <button
            key={r}
            className={`chip${dir === r || dir.startsWith(`${r}/`) ? " on" : ""}`}
            onClick={() => setDir(r)}
          >
            {titleOf(r)}
          </button>
        ))}
      </div>
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          margin: "0 -20px",
          padding: "0 20px",
        }}
      >
        <div
          className="glass group"
          style={{ borderRadius: 18, "--inset": "62px" } as CSSProperties}
        >
          {dir.split("/").length > 2 && (
            <button
              className="row"
              style={{ minHeight: 54 }}
              onClick={() => setDir(parentOf(dir))}
            >
              <span
                className="row-ico"
                style={{ "--c": "#71717a" } as CSSProperties}
              >
                <Icon name="back" size={18} />
              </span>
              <span className="main">
                <b style={{ fontWeight: 550 }}>{titleOf(parentOf(dir))}</b>
              </span>
            </button>
          )}
          {listing.isLoading && (
            <div className="row static">
              <span className="spinner" />
            </div>
          )}
          {folders.map((f) => (
            <button
              key={f.path}
              className="row"
              style={{ minHeight: 54 }}
              onClick={() => setDir(f.path)}
            >
              <span
                className="row-ico"
                style={{ "--c": "#3b82f6" } as CSSProperties}
              >
                <Icon name="folder-filled" size={18} />
              </span>
              <span className="main">
                <b style={{ fontWeight: 550 }}>{f.name}</b>
              </span>
              <Icon name="chevron" size={18} className="chev" />
            </button>
          ))}
          {!listing.isLoading && folders.length === 0 && (
            <div className="row static muted">No folders here</div>
          )}
        </div>
      </div>
      <button
        className="btn primary block"
        style={{ marginTop: 14 }}
        disabled={busy || blocked || !!listing.error}
        onClick={async () => {
          setBusy(true);
          await onPick(dir);
          setBusy(false);
        }}
      >
        {busy && <span className="spinner" />}
        {mode === "move" ? "Move here" : "Copy here"}
      </button>
    </Sheet>
  );
}

// ---- uploads panel ------------------------------------------------------------------------------
function UploadPanel({
  uploads,
  onClear,
}: {
  uploads: Upload[];
  onClear: () => void;
}) {
  const active = uploads.filter((u) => u.state === "uploading");
  const total = uploads.reduce((t, u) => t + u.total, 0);
  const loaded = uploads.reduce((t, u) => t + u.loaded, 0);
  const failed = uploads.filter((u) => u.state === "error").length;
  return (
    <div className="upload-panel glass" role="status" aria-live="polite">
      <span
        className="file-icon"
        style={
          {
            width: 40,
            height: 40,
            "--c": active.length
              ? "var(--accent)"
              : failed
                ? "var(--red)"
                : "var(--green)",
          } as CSSProperties
        }
      >
        {active.length ? (
          <span className="spinner" />
        ) : (
          <Icon name={failed ? "alert" : "check"} size={20} />
        )}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <b style={{ display: "block", fontSize: 14, fontWeight: 620 }}>
          {active.length
            ? `Uploading ${active.length} of ${uploads.length}`
            : failed
              ? `${failed} upload${failed > 1 ? "s" : ""} failed`
              : "Upload complete"}
        </b>
        <span className="progress" style={{ display: "block", marginTop: 7 }}>
          <i style={{ width: `${total ? (loaded / total) * 100 : 100}%` }} />
        </span>
        <span
          className="muted num"
          style={{ fontSize: 12, marginTop: 4, display: "block" }}
        >
          {bytes(loaded)} of {bytes(total)}
        </span>
      </span>
      {!active.length && (
        <button className="icon-btn" aria-label="Dismiss" onClick={onClear}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

// ---- SMB share info ----------------------------------------------------------------------------------
// Share a folder on your home LAN (Samba), or see and change how it's shared. Other computers open
// it at smb://<server>/<name>; with a password, they sign in with your server account's user name
// and your share password.
/** Module-level radio choice so re-renders keep focus on the active access option. */
function ShareAccessChoice({
  name,
  on,
  title,
  note,
  onPick,
  disabled,
}: {
  name: string;
  on: boolean;
  title: string;
  note: string;
  onPick: () => void;
  disabled?: boolean;
}) {
  return (
    <label style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 2px", fontSize: 14.5, opacity: disabled ? 0.55 : 1 }}>
      <input type="radio" name={name} checked={on} disabled={disabled} onChange={onPick} />
      <span>
        {title}
        <small className="muted" style={{ display: "block" }}>{note}</small>
      </span>
    </label>
  );
}

export function ShareSheet({
  path,
  name,
  host,
  username,
  onClose,
}: {
  path: string;
  name: string;
  host: string;
  username?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const accessRadioName = useId();
  const shares = useQuery({ queryKey: ["files.shares"], queryFn: () => query<SmbShare[]>("files.shares") });
  const options = useQuery({
    queryKey: ["files.shareOptions"],
    queryFn: () =>
      query<{ noPassword: boolean; samba?: { ok: boolean; problem?: "missing" | "mismatch"; command?: string; versions?: Record<string, string | null> } }>("files.shareOptions"),
    retry: false,
    // Waiting for the one-time Samba fix: notice as soon as it's done.
    refetchInterval: (q) => (q.state.data?.samba && !q.state.data.samba.ok ? 3000 : false),
  });
  const samba = options.data?.samba;
  const share = shares.data?.find((s) => s.path === path) ?? null;
  const [needPassword, setNeedPassword] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [changing, setChanging] = useState(false);
  const [newPw, setNewPw] = useState("");
  const pw = useQuery({
    queryKey: ["files.sharePassword"],
    queryFn: () => query<string>("files.sharePassword"),
    enabled: reveal,
    retry: false,
  });
  const run = useMutation({
    mutationFn: (a: { path: string; input: unknown; done: string }) => mutate(a.path, a.input).then(() => a.done),
    onSuccess: (done) => {
      toast(done);
      qc.invalidateQueries({ queryKey: ["files.shares"] });
      qc.invalidateQueries({ queryKey: ["files.sharePassword"] });
    },
    onError: (e) => toast((e as Error).message, true),
  });
  const copy = (v: string, what: string) =>
    copyTextOrToast(
      navigator.clipboard?.writeText ? (text) => navigator.clipboard.writeText(text) : undefined,
      v,
      () => toast(`${what} copied`),
      () => toast(v),
    );
  const noPasswordOk = options.data?.noPassword === true;
  const passwordChoices = (current: boolean, pick: (v: boolean) => void) => (
    <div className="glass card" style={{ borderRadius: 18, marginBottom: 12 }}>
      <b style={{ fontSize: 14 }}>Who can open it</b>
      <ShareAccessChoice name={accessRadioName} on={current} title="Password needed" note={`Sign in as ${username ?? "your server user"} with your share password.`} onPick={() => pick(true)} />
      <ShareAccessChoice
        name={accessRadioName}
        on={!current}
        title="No password"
        note={noPasswordOk ? "Anyone on your home LAN can open it. Writes are not saved as you. Only for folders you don’t mind anyone at home seeing." : "Needs Omarchy Server’s installer to run once more on this server."}
        onPick={() => pick(false)}
        disabled={!noPasswordOk}
      />
    </div>
  );
  const readOnlyToggle = (current: boolean, set: (v: boolean) => void) => (
    <label className="glass card" style={{ display: "flex", gap: 10, alignItems: "center", borderRadius: 18, marginBottom: 12, fontSize: 14.5 }}>
      <input type="checkbox" checked={current} onChange={(e) => set(e.target.checked)} />
      <span>
        Read only
        <small className="muted" style={{ display: "block" }}>Other computers can open and copy files, but not change or delete them.</small>
      </span>
    </label>
  );
  const rows: [string, string, string][] = share
    ? [
        ["Mac / Linux / iPhone", `smb://${host}/${share.sharename}`, "Address"],
        ["Windows", `\\\\${host}\\${share.sharename}`, "Address"],
      ]
    : [];
  return (
    <Sheet open onClose={onClose} label="Network share">
      <SheetHeader
        icon={
          <span className="file-icon" style={{ width: 52, height: 52, "--c": "#0ea5e9" } as CSSProperties}>
            <Icon name="folder-share" size={28} />
          </span>
        }
        title={share?.name ?? name}
        subtitle={
          share
            ? share.available === false
              ? "This folder is no longer there"
              : "Shared on your home LAN"
            : "Share this folder with computers on your home LAN"
        }
        onClose={onClose}
      />
      {samba && !samba.ok && (
        <div className="glass card" style={{ borderRadius: 18, marginBottom: 12 }}>
          <b style={{ fontSize: 14.5, display: "block", marginBottom: 4 }}>
            {samba.problem === "missing" ? "Samba needs installing first" : "Samba needs a system update first"}
          </b>
          <p className="prose" style={{ margin: "0 0 10px", fontSize: 14 }}>
            {samba.problem === "missing"
              ? "Network shares use Samba, which isn’t installed on this server yet."
              : `Samba (${samba.versions?.samba}) and its libraries (${samba.versions?.smbclient}) are different versions, after a partial update. Updating the system once brings them back in step.`}{" "}
            Run this in a terminal on the server; it asks for your password itself.
          </p>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", userSelect: "all", fontSize: 12.5, padding: 10, borderRadius: 10, background: "rgba(0,0,0,.25)", margin: "0 0 10px" }}>{samba.command}</pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={() => (onClose(), openTerminalWith(samba.command!))}>
              <Icon name="terminal" size={17} /> Open Terminal
            </button>
            <button className="btn ghost" onClick={() => copy(samba.command!, "Command")}>
              Copy
            </button>
          </div>
          <p className="muted" style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, margin: "10px 0 0" }}>
            <span className="spinner" /> This updates by itself once it’s done.
          </p>
        </div>
      )}
      {shares.isLoading ? (
        <p className="muted">Loading…</p>
      ) : !share ? (
        <>
          {passwordChoices(needPassword, setNeedPassword)}
          {readOnlyToggle(readOnly, setReadOnly)}
          <button
            className="btn primary"
            style={{ width: "100%" }}
            disabled={run.isPending || (!!samba && !samba.ok)}
            onClick={() => run.mutate({ path: "files.addShare", input: { path, password: needPassword, readOnly }, done: "Shared on your network" })}
          >
            {run.isPending ? <span className="spinner" /> : <Icon name="folder-share" size={18} />} Share on network
          </button>
        </>
      ) : (
        <>
          <div className="kv glass group" style={{ borderRadius: 18, marginTop: 0 }}>
            {rows.map(([k, v, what]) => (
              <button key={k} className="row" style={{ minHeight: 56 }} onClick={() => copy(v, what)}>
                <span className="k">{k}</span>
                <span className="v mono" style={{ fontSize: 12.5 }}>{v}</span>
              </button>
            ))}
            {share.password && username && (
              <button className="row" style={{ minHeight: 56 }} onClick={() => copy(username, "Username")}>
                <span className="k">Username</span>
                <span className="v mono">{username}</span>
              </button>
            )}
            {share.password && (
              <button
                className="row"
                style={{ minHeight: 56 }}
                onClick={() => {
                  const action = sharePasswordAction({ data: pw.data, reveal, isFetching: pw.isFetching });
                  if (action === "copy") copy(pw.data!, "Password");
                  else if (action === "refetch") void pw.refetch();
                  else if (action === "reveal") setReveal(true);
                }}
              >
                <span className="k">Password</span>
                <span
                  className={!pw.data && pw.error && !pw.isFetching ? "v" : "v mono"}
                  style={{ fontSize: 12.5, ...(!pw.data && pw.error && !pw.isFetching ? { color: "var(--red)" } : {}) }}
                >
                  {sharePasswordLabel({ data: pw.data, isFetching: pw.isFetching, error: pw.error })}
                </span>
              </button>
            )}
          </div>
          <p className="footer-note" style={{ textAlign: "left", margin: "0 4px 14px" }}>
            Tap any line to copy it. On iPhone, open Files → ⋯ → Connect to Server.
          </p>
          {passwordChoices(share.password, (v) => v !== share.password && run.mutate({ path: "files.updateShare", input: { path, password: v }, done: v ? "Now needs a password" : "Open to your network without a password" }))}
          {readOnlyToggle(share.readOnly, (v) => run.mutate({ path: "files.updateShare", input: { path, readOnly: v }, done: v ? "Now read only" : "Can be changed from other computers" }))}
          {share.password && (
            <div className="glass card" style={{ borderRadius: 18, marginBottom: 12 }}>
              {!changing ? (
                <button className="btn ghost" onClick={() => setChanging(true)}>
                  <Icon name="key" size={17} /> Choose your own share password
                </button>
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    run.mutate({ path: "files.setSharePassword", input: { password: newPw }, done: "Share password changed" }, { onSuccess: () => (setChanging(false), setNewPw(""), setReveal(true)) });
                  }}
                >
                  <div className="field">
                    <input type="password" autoComplete="new-password" placeholder="At least 8 characters" value={newPw} onChange={(e) => setNewPw(e.target.value)} aria-label="New share password" />
                  </div>
                  <small className="muted" style={{ display: "block", margin: "6px 2px 10px" }}>It’s for every folder you share with a password. Computers that saved the old one will ask again.</small>
                  <button className="btn primary" disabled={newPw.length < 8 || run.isPending}>Save password</button>
                </form>
              )}
            </div>
          )}
          <button
            className="btn danger"
            style={{ width: "100%" }}
            disabled={run.isPending}
            onClick={async () => {
              if (await confirm({ title: `Stop sharing “${share.name}”?`, body: "Computers on your network will no longer see this folder. Its files stay where they are.", confirm: "Stop sharing" }))
                run.mutate({ path: "files.removeShare", input: { path }, done: "No longer shared" }, { onSuccess: onClose });
            }}
          >
            Stop sharing
          </button>
        </>
      )}
    </Sheet>
  );
}
