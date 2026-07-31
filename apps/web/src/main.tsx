import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { theme } from "./theme";
import { applyLanguage, storedLanguage } from "./i18n";
import { AuthProvider } from "./auth/AuthContext";
import { App } from "./App";

// Set the language (and <html lang>) before first paint, so Burmese line
// breaking is right from the first frame rather than after a flash of English.
applyLanguage(storedLanguage());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);
