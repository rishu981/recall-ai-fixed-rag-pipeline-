import {
  ALLOWED_UPLOAD_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  type AllowedType,
  type Attachment,
} from "@recallai/shared-types";

/**
 * Client-side validation for fast feedback. The backend must validate again —
 * nothing here is a security boundary.
 */

export function specFor(file: File): AllowedType {
  const name = file.name.toLowerCase();
  const found = ALLOWED_UPLOAD_TYPES.find((t) => t.extensions.some((e) => name.endsWith(e)));
  if (found) return found;
  return {
    label: "Study Material",
    extensions: ["*"],
    mimeTypes: ["*/*"],
    kind: file.type?.startsWith("image/") ? "image" : "document",
    maxBytes: 2 * 1024 * 1024 * 1024,
  };
}

export function validateFile(file: File): string | null {
  // Support any file type for student study materials and textbooks
  const maxAllowed = 2 * 1024 * 1024 * 1024; // 2 GB
  if (file.size > maxAllowed) {
    return `${file.name} is ${formatBytes(file.size)}. Files up to 2 GB are supported.`;
  }
  return null;
}

export function canAddMore(current: number): string | null {
  return current >= MAX_ATTACHMENTS_PER_MESSAGE
    ? `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`
    : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

const LOCAL = new Map<string, Attachment>();

/** Registers a browser-only attachment so it can be rendered before upload. */
export function trackLocal(file: File): Attachment {
  const spec = specFor(file);
  const record: Attachment = {
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    kind: spec?.kind ?? "document",
    status: "queued",
    progress: 0,
    local: true,
    previewUrl:
      spec?.kind === "image" ? URL.createObjectURL(file) : undefined,
  };
  LOCAL.set(keyFor(record), record);
  return record;
}

function keyFor(a: Attachment) {
  return `${a.name}:${a.size}:${a.local ? "local" : (a.id ?? "")}`;
}

export function mergeLocal(
  incoming: Attachment[],
  local: Attachment[],
): Attachment[] {
  const byKey = new Map(local.map((a) => [keyFor(a), a]));
  const out = incoming.map((a) => {
    const l = byKey.get(keyFor(a));
    return l ? { ...a, previewUrl: a.previewUrl ?? l.previewUrl } : a;
  });
  return [...out, ...local.filter((l) => !incoming.some((a) => keyFor(a) === keyFor(l)))];
}

export function revokePreview(a: Attachment) {
  if (a.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(a.previewUrl);
}