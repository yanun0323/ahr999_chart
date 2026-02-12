import { Combobox as ComboboxPrimitive } from "@kobalte/core/combobox";
import { Show, createMemo } from "solid-js";

export interface ComboboxOptionItem {
  value: string;
  label: string;
  isStarred?: boolean;
}

interface SearchableComboboxFieldProps {
  label: string;
  options: ComboboxOptionItem[];
  value: string;
  disabled?: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onToggleOptionStar?: (value: string) => void;
  optionStarButtonAriaLabel?: (option: ComboboxOptionItem) => string;
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
      triggerMode="focus"
      value={selectedOption()}
      onChange={(nextValue: ComboboxOptionItem | null) => props.onChange(nextValue?.value ?? "")}
      placeholder={props.placeholder}
      defaultFilter="contains"
      disabled={props.disabled}
      itemComponent={(itemProps: any) => (
        <ComboboxPrimitive.Item item={itemProps.item} class="combo-item">
          <div class="combo-item-content">
            <Show when={props.onToggleOptionStar}>
              <button
                type="button"
                class={`combo-star-button ${itemProps.item.rawValue.isStarred ? "is-starred" : ""}`}
                aria-label={
                  props.optionStarButtonAriaLabel?.(itemProps.item.rawValue) ??
                  (itemProps.item.rawValue.isStarred
                    ? `取消 ${itemProps.item.rawValue.label} 星號`
                    : `將 ${itemProps.item.rawValue.label} 設為星號`)
                }
                disabled={props.disabled}
                onPointerDown={(event) => {
                  const optionValue = String(itemProps.item.rawValue.value ?? "");
                  event.stopPropagation();
                  event.preventDefault();
                  props.onToggleOptionStar?.(optionValue);
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                {itemProps.item.rawValue.isStarred ? "★" : "☆"}
              </button>
            </Show>
            <ComboboxPrimitive.ItemLabel class="combo-item-label">
              {itemProps.item.rawValue.label}
            </ComboboxPrimitive.ItemLabel>
          </div>
        </ComboboxPrimitive.Item>
      )}
    >
      <ComboboxPrimitive.HiddenSelect />
      <ComboboxPrimitive.Label class="select-label">{props.label}</ComboboxPrimitive.Label>

      <ComboboxPrimitive.Control class="combo-control">
        <ComboboxPrimitive.Input class="combo-input" />
      </ComboboxPrimitive.Control>

      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Content class="combo-content">
          <ComboboxPrimitive.Listbox class="combo-listbox" />
        </ComboboxPrimitive.Content>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive>
  );
};
