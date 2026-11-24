import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { TagPage } from "../src/features/discover/Discover";
import "../src/index.css";

const tag = new URLSearchParams(location.search).get("tag") || "悬疑";

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <TagPage tag={tag} name={tag} onBack={() => {}} wide={false} />
  </AppProvider>,
);
