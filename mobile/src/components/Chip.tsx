import { Pressable, StyleSheet, Text } from "react-native";

interface Props {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}

/** A single-choice option. Selection is conveyed by state, border and a
 * check mark, never by color alone. */
export function Chip({ label, selected, onPress, disabled }: Props) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      aria-checked={selected}
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={[styles.chip, selected && styles.selected]}
    >
      <Text style={[styles.text, selected && styles.selectedText]}>{selected ? `✓ ${label}` : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderWidth: 2,
    borderColor: "#1a1a1a",
    borderRadius: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 44,
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  selected: { backgroundColor: "#0b5fff", borderColor: "#0b5fff" },
  text: { fontSize: 15, fontWeight: "600", color: "#1a1a1a" },
  selectedText: { color: "#fff" },
});
