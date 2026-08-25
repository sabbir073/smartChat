import { describe, expect, it } from 'vitest';
import { DEFAULT_WIDGET_CONFIG } from '@smartchat/validation';
import { mergeWidgetConfig } from './widget.service.js';

describe('mergeWidgetConfig', () => {
  it('changes only what the update names', () => {
    const merged = mergeWidgetConfig(DEFAULT_WIDGET_CONFIG, {
      appearance: { primaryColor: '#111111' },
    });
    expect(merged.appearance.primaryColor).toBe('#111111');
    expect(merged.appearance.headerColor).toBe(DEFAULT_WIDGET_CONFIG.appearance.headerColor);
    expect(merged.content).toEqual(DEFAULT_WIDGET_CONFIG.content);
  });

  it('merges several sections at once', () => {
    const merged = mergeWidgetConfig(DEFAULT_WIDGET_CONFIG, {
      placement: { position: 'bottom_left' },
      content: { businessName: 'ABC Digital' },
    });
    expect(merged.placement.position).toBe('bottom_left');
    expect(merged.content.businessName).toBe('ABC Digital');
    expect(merged.placement.offsetX).toBe(DEFAULT_WIDGET_CONFIG.placement.offsetX);
  });

  /**
   * Replacing, not merging, is the intended behaviour for the form definitions: an agent removing
   * a field must actually remove it, and a deep merge of arrays would silently keep it.
   */
  it('replaces form field lists rather than merging them', () => {
    const merged = mergeWidgetConfig(DEFAULT_WIDGET_CONFIG, {
      forms: {
        preChatFields: [{ key: 'name', label: 'Name', type: 'text', requirement: 'required' }],
      },
    });
    expect(merged.forms.preChatFields).toHaveLength(1);
    expect(merged.forms.offlineFields).toEqual(DEFAULT_WIDGET_CONFIG.forms.offlineFields);
  });

  it('rejects an invalid value instead of storing something the widget cannot render', () => {
    expect(() =>
      mergeWidgetConfig(DEFAULT_WIDGET_CONFIG, {
        appearance: { primaryColor: 'not-a-colour' as never },
      }),
    ).toThrow();

    expect(() =>
      mergeWidgetConfig(DEFAULT_WIDGET_CONFIG, {
        appearance: { borderRadius: 9999 as never },
      }),
    ).toThrow();
  });

  it('is pure - the original config is never mutated', () => {
    const snapshot = JSON.stringify(DEFAULT_WIDGET_CONFIG);
    mergeWidgetConfig(DEFAULT_WIDGET_CONFIG, { content: { title: 'Changed' } });
    expect(JSON.stringify(DEFAULT_WIDGET_CONFIG)).toBe(snapshot);
  });
});
