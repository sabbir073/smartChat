import { useState, type FormEvent } from 'react';
import type { FormField } from '@smartchat/validation';

/**
 * The pre-chat form, rendered entirely from configuration.
 *
 * Nothing here is hardcoded: the customer decides which fields exist, what they are called and
 * whether they are required, so adding a field is a configuration change rather than a release.
 */
export function PreChatForm({
  intro,
  fields,
  submitLabel,
  busy,
  onSubmit,
}: {
  intro: string;
  fields: FormField[];
  submitLabel: string;
  busy: boolean;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const visible = fields.filter((field) => field.requirement !== 'disabled');
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    for (const field of visible) {
      const value = (values[field.key] ?? '').trim();
      if (field.requirement === 'required' && value.length === 0) {
        found[field.key] = `${field.label} is required`;
        continue;
      }
      if (field.type === 'email' && value.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        found[field.key] = 'Enter a valid email address';
      }
      if (value.length > 2000) found[field.key] = 'That is too long';
    }
    return found;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Move focus to the first problem so a keyboard or screen-reader user is not left guessing.
      const firstKey = visible.find((field) => found[field.key])?.key;
      if (firstKey) document.getElementById(`sc-field-${firstKey}`)?.focus();
      return;
    }
    onSubmit(values);
  }

  const update = (key: string) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  return (
    <form className="form" onSubmit={handleSubmit} noValidate>
      {intro && <p className="form-intro">{intro}</p>}

      {visible.map((field) => {
        const id = `sc-field-${field.key}`;
        const errorId = `${id}-error`;
        const invalid = Boolean(errors[field.key]);
        const shared = {
          id,
          name: field.key,
          'aria-invalid': invalid || undefined,
          'aria-describedby': invalid ? errorId : undefined,
          placeholder: field.placeholder,
          required: field.requirement === 'required',
          value: values[field.key] ?? '',
        };

        return (
          <div className="field" key={field.key}>
            {field.type !== 'checkbox' && <label htmlFor={id}>{field.label}</label>}

            {field.type === 'textarea' ? (
              <textarea
                {...shared}
                maxLength={2000}
                onChange={(event) => update(field.key)(event.target.value)}
              />
            ) : field.type === 'select' ? (
              <select {...shared} onChange={(event) => update(field.key)(event.target.value)}>
                <option value="">Choose…</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.type === 'checkbox' ? (
              <label className="checkbox-field" htmlFor={id}>
                <input
                  id={id}
                  name={field.key}
                  type="checkbox"
                  checked={values[field.key] === 'yes'}
                  onChange={(event) => update(field.key)(event.target.checked ? 'yes' : '')}
                />
                <span>{field.label}</span>
              </label>
            ) : (
              <input
                {...shared}
                type={field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : 'text'}
                inputMode={field.type === 'phone' ? 'tel' : undefined}
                autoComplete={
                  field.type === 'email' ? 'email' : field.key === 'name' ? 'name' : 'off'
                }
                maxLength={300}
                onChange={(event) => update(field.key)(event.target.value)}
              />
            )}

            {invalid && (
              <p className="field-error" id={errorId} role="alert">
                {errors[field.key]}
              </p>
            )}
          </div>
        );
      })}

      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? 'Please wait…' : submitLabel}
      </button>
    </form>
  );
}
