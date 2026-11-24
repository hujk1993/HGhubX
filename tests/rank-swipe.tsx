import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import { RankPage } from "../src/features/search/Search";
import "../src/index.css";

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <RankPage onBack={() => {}} wide={false} />
  </AppProvider>,
);
