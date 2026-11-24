import { createRoot } from "react-dom/client";
import { AppProvider } from "../src/shared/model/store";
import Search from "../src/features/search/Search";
import "../src/index.css";

createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <Search active wide={false} />
  </AppProvider>,
);
