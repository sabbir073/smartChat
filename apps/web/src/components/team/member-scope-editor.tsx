'use client';

import { useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { Alert, Button, Field, Modal, Select, TextInput } from '@/components/ui';
import { CheckboxGroup } from './checkbox-group';
import type { DepartmentDto, MemberDto, PropertyDto, RoleDto } from '@/lib/types';

const ROLES = ['owner', 'admin', 'manager', 'agent'] as const;

/**
 * Everything an administrator can change about one member.
 *
 * Removal lives behind a two-step confirmation inside the same dialog rather than a second modal:
 * the person's name and email are still on screen while they confirm, which is the point.
 */
export function MemberScopeEditor({
  member,
  properties,
  departments,
  roles,
  isSelf,
  onClose,
  onSaved,
  onRemoved,
  onError,
}: {
  member: MemberDto;
  properties: PropertyDto[];
  departments: DepartmentDto[];
  roles: RoleDto[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
  onRemoved: () => void;
  onError: (message: string) => void;
}) {
  const [baseRole, setBaseRole] = useState(member.role);
  const [roleId, setRoleId] = useState(member.customRole?.id ?? '');
  const [title, setTitle] = useState(member.title ?? '');
  const [status, setStatus] = useState(member.status === 'disabled' ? 'disabled' : 'active');
  const [restricted, setRestricted] = useState(member.restrictedToProperties);
  const [propertyIds, setPropertyIds] = useState<string[]>(member.propertyIds);
  const [departmentIds, setDepartmentIds] = useState<string[]>(member.departmentIds);
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const pending = member.status === 'invited';

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.patch(`/team/members/${member.id}`, {
        baseRole,
        roleId: roleId === '' ? null : roleId,
        title: title.trim() === '' ? null : title.trim(),
        ...(pending ? {} : { status }),
        restrictedToProperties: restricted,
        propertyIds: restricted ? propertyIds : [],
        departmentIds,
      });
      onSaved();
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'That change could not be saved');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await api.delete(`/team/members/${member.id}`);
      onRemoved();
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'That person could not be removed');
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={member.displayName ?? member.name}>
      <form onSubmit={save} className="space-y-4">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <p className="text-[13px] text-ink-subtle">{member.email}</p>

        <Field label="Role">
          {({ id }) => (
            <Select id={id} value={baseRole} onChange={(event) => setBaseRole(event.target.value)}>
              {ROLES.map((role) => (
                <option key={role} value={role} className="capitalize">
                  {role}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {roles.length > 0 && (
          <Field
            label="Custom role"
            hint="Optional. Replaces the permissions the role above implies."
          >
            {({ id }) => (
              <Select id={id} value={roleId} onChange={(event) => setRoleId(event.target.value)}>
                <option value="">None</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        <Field label="Job title" hint="Shown to visitors alongside replies.">
          {({ id }) => (
            <TextInput
              id={id}
              value={title}
              maxLength={120}
              placeholder="Support specialist"
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>

        {!pending && (
          <Field
            label="Access"
            hint={
              isSelf
                ? 'You cannot disable your own access.'
                : 'A disabled member keeps their history but cannot sign in to this workspace.'
            }
          >
            {({ id }) => (
              <Select
                id={id}
                value={status}
                disabled={isSelf}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </Select>
            )}
          </Field>
        )}

        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            type="checkbox"
            checked={restricted}
            onChange={(event) => setRestricted(event.target.checked)}
            className="mt-0.5 size-4"
          />
          <span>
            Limit them to specific websites
            <span className="block text-[12px] text-ink-subtle">
              Conversations from any other website become invisible to them, including by direct
              link.
            </span>
          </span>
        </label>

        {restricted && (
          <CheckboxGroup
            label="Websites"
            empty="You have no websites yet."
            options={properties.map((property) => ({ id: property.id, label: property.name }))}
            selected={propertyIds}
            onChange={setPropertyIds}
          />
        )}

        {departments.length > 0 && (
          <CheckboxGroup
            label="Departments"
            empty=""
            options={departments.map((department) => ({
              id: department.id,
              label: department.name,
            }))}
            selected={departmentIds}
            onChange={setDepartmentIds}
          />
        )}

        {confirmingRemove ? (
          <Alert tone="danger" title="Remove this person?">
            <div className="space-y-2">
              <p>
                {member.email} loses access immediately. Their messages and notes stay in the
                conversations they worked on.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setConfirmingRemove(false)}
                >
                  Keep them
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  loading={saving}
                  onClick={() => void remove()}
                >
                  Remove
                </Button>
              </div>
            </div>
          </Alert>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {isSelf ? (
              <span className="text-[12px] text-ink-subtle">You cannot remove yourself.</span>
            ) : (
              <Button type="button" variant="ghost" onClick={() => setConfirmingRemove(true)}>
                Remove from team
              </Button>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" loading={saving}>
                Save changes
              </Button>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}
