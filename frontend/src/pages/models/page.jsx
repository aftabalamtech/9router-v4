import AvailableModelsSection from "@/shared/components/AvailableModelsSection";

// ── Models page ──────────────────────────────────────────────────
// The page is now a thin host for the shared Available Models section. All
// catalog building, filters, cards and model actions live in that one
// component, which the provider detail pages reuse — so a model behaves
// identically wherever it is managed.
export default function ModelsPage() {
  return (
    <div className="flex flex-col gap-4">
      <AvailableModelsSection headerTitle="Available Models" />
    </div>
  );
}
