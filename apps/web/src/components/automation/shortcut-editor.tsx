'use client';

import { Button, Field, Modal, TextInput } from '@/components/ui';
import type { ShortcutDto } from '@/lib/types';

export interface ShortcutDraft {
  id?: string;
  key: string;
  title: string;
  body: string;
}

export function emptyShortcut(): ShortcutDraft {
  return { key: '', title: '', body: '' };
}

export function shortcutDraftFrom(shortcut: ShortcutDto): ShortcutDraft {
  return { id: shortcut.id, key: shortcut.key, title: shortcut.title, body: shortcut.body };
}

/**
 * A saved reply.
 *
 * The key is shown with its leading slash because that is how an agent will type it - a field
 * labelled "key" that silently gains a slash later is a small mystery nobody needs.
 */
export function ShortcutEditor({
  open,
  draft,
  placeholders,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean;
  draft: ShortcutDraft;
  placeholders: string[];
  saving: boolean;
  error: string | null;
  onChange: (draft: ShortcutDraft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const set = (patch: Partial<ShortcutDraft>) => onChange({ ...draft, ...patch });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={draft.id ? 'Edit shortcut' : 'New shortcut'}
      description="Text your team can drop into a reply by typing / in the composer."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={onSave} loading={saving}>
            {draft.id ? 'Save changes' : 'Create shortcut'}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        {error && (
          <p className="rounded-[var(--radius-control)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        <Field
          label="Shortcut"
          hint="Lowercase letters, numbers, hyphens and underscores."
          required
        >
          {({ id, describedBy }) => (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-ink-subtle">/</span>
              <TextInput
                id={id}
                aria-describedby={describedBy}
                className="font-mono"
                value={draft.key}
                maxLength={32}
                placeholder="refund"
                onChange={(event) => set({ key: event.target.value.toLowerCase() })}
              />
            </div>
          )}
        </Field>

        <Field label="Name" hint="What the picker shows beside the shortcut." required>
          {({ id }) => (
            <TextInput
              id={id}
              value={draft.title}
              maxLength={80}
              placeholder="Refund policy"
              onChange={(event) => set({ title: event.target.value })}
            />
          )}
        </Field>

        <Field
          label="Text"
          hint={`You can use ${placeholders.join(', ')}. Anything we cannot fill in is left visible so the agent can see it.`}
          required
        >
          {({ id }) => (
            <textarea
              id={id}
              rows={5}
              maxLength={2000}
              value={draft.body}
              placeholder="Hi {{visitor.name}}, refunds take 5-7 working days once approved."
              onChange={(event) => set({ body: event.target.value })}
              className="w-full resize-y rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle"
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}
