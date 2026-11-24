import { createContext } from "react";

/** True while an ancestor tab or stack layer is covered by a higher page in the shell. */
export const PageCoveredContext = createContext(false);
