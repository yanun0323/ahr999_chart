import { Combobox as ComboboxPrimitive } from "@kobalte/core/combobox";
import { createMemo } from "solid-js";

export interface ComboboxOptionItem {
  value: string;
  label: string;
}

interface SearchableComboboxFieldProps {
  label: string;
  options: ComboboxOptionItem[];
  value: string;
  disabled?: boolean;
  placeholder: string;
  triggerAriaLabel: string;
  onChange: (value: string) => void;
}

export const SearchableComboboxField = (props: SearchableComboboxFieldProps) => {
  const selectedOption = createMemo(() =>
    props.options.find((option) => option.value === props.value)
  );

  return (
    <ComboboxPrimitive<ComboboxOptionItem>
      class="select-field"
      options={props.options}
      optionValue="value"
      optionLabel="label"
      optionTextValue="label"
      multiple={false}
      value={selectedOption()}
      onChange={(nextValue: ComboboxOptionItem | null) => props.onChange(nextValue?.value ?? "")}
      placeholder={props.placeholder}
      defaultFilter="contains"
      disabled={props.disabled}
      itemComponent={(itemProps: any) => (
        <ComboboxPrimitive.Item item={itemProps.item} class="combo-item">
          <ComboboxPrimitive.ItemLabel>{itemProps.item.rawValue.label}</ComboboxPrimitive.ItemLabel>
        </ComboboxPrimitive.Item>
      )}
    >
      <ComboboxPrimitive.HiddenSelect />
      <ComboboxPrimitive.Label class="select-label">{props.label}</ComboboxPrimitive.Label>

      <ComboboxPrimitive.Control class="combo-control">
        <ComboboxPrimitive.Input class="combo-input" />
        <ComboboxPrimitive.Trigger class="combo-trigger" aria-label={props.triggerAriaLabel}>
          <span class="combo-trigger-icon">▾</span>
        </ComboboxPrimitive.Trigger>
      </ComboboxPrimitive.Control>

      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Content class="combo-content">
          <ComboboxPrimitive.Listbox class="combo-listbox" />
        </ComboboxPrimitive.Content>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive>
  );
};
