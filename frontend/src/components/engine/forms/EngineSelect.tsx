/**
 * Select Component - Dropdown select with label support
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { get } from 'lodash-es';
import type { EngineComponentProps, ActionDefinition } from '@/engine/types';
import { useUIEngine } from '@/engine/UIEngineContext';

// Security: keep lodash-es usage limited to `get` here; do not introduce `_.template`.
interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface EngineSelectProps extends EngineComponentProps {
  value?: string;
  onChange?: ActionDefinition;
  options?: Array<SelectOption | Record<string, unknown>>;
  optionValueField?: string;
  optionLabelField?: string;
  placeholder?: string;
  label?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  error?: string;
  className?: string;
}

export function EngineSelect({
  value,
  onChange,
  options = [],
  optionValueField,
  optionLabelField,
  placeholder = 'Select...',
  label,
  name,
  disabled = false,
  required = false,
  error,
  className,
}: EngineSelectProps) {
  const { dispatch } = useUIEngine();

  // Allow Select to consume both canonical {value,label} options and entity rows.
  // Priority: explicit value/label -> configured field path -> common entity keys.
  const resolvedOptions: SelectOption[] = options.flatMap((option) => {
    if (!option || typeof option !== 'object') {
      return [];
    }

    const optionRecord = option as Record<string, unknown>;
    const resolvedValue = Object.prototype.hasOwnProperty.call(optionRecord, 'value')
      ? optionRecord.value
      : (
        (optionValueField ? get(optionRecord, optionValueField) : undefined)
        ?? optionRecord.id
        ?? optionRecord.source_record_id
      );

    if (resolvedValue == null) {
      return [];
    }

    const resolvedLabel = Object.prototype.hasOwnProperty.call(optionRecord, 'label')
      ? optionRecord.label
      : (
        (optionLabelField ? get(optionRecord, optionLabelField) : undefined)
        ?? optionRecord.name
        ?? optionRecord.source_record_id
        ?? resolvedValue
      );

    return [{
      value: String(resolvedValue),
      label: resolvedLabel == null ? String(resolvedValue) : String(resolvedLabel),
      disabled: Boolean(optionRecord.disabled),
    }];
  });

  const handleChange = (newValue: string) => {
    if (onChange) {
      dispatch(onChange, { event: { target: { value: newValue } } });
    }
  };

  const selectId = name || `select-${Math.random().toString(36).slice(2, 9)}`;

  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <Label htmlFor={selectId}>
          {label}
          {required && <span className="text-destructive ml-1">*</span>}
        </Label>
      )}
      <Select
        value={value}
        onValueChange={handleChange}
        disabled={disabled}
      >
        <SelectTrigger
          id={selectId}
          className={cn(error && 'border-destructive')}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {resolvedOptions.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
