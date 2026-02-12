import { Show } from "solid-js";
import { Button } from "./Button";

interface StateCardProps {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export const StateCard = (props: StateCardProps) => {
  return (
    <section class="state-card" aria-live="polite">
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      <Show when={props.actionLabel && props.onAction}>
        <Button onClick={props.onAction}>{props.actionLabel}</Button>
      </Show>
    </section>
  );
};
