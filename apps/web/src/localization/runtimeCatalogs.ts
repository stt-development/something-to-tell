/** Application startup errors follow UI locale and never expose native payloads. */
export const enRuntimeCatalog = {
  "runtime.starting": "Starting the application...",
  "runtime.startFailed": "The application could not be started.",
  "runtime.retry": "Try again",
  "runtime.closeWithoutSave": "Close the application without saving? Recovery may be needed when reopening the project.",
  "runtime.closeFailed": "The window could not be closed. Try again.",
  "runtime.closeApplication": "Close application",
  "runtime.lost": "The application connection was lost.",
  "runtime.lostDetails": "Work on the project is paused. Close this window and reopen the application. Unsaved changes may require recovery when opening the project again."
};

export const ruRuntimeCatalog: Record<keyof typeof enRuntimeCatalog, string> = {
  "runtime.starting": "Запуск приложения...",
  "runtime.startFailed": "Не удалось запустить приложение.",
  "runtime.retry": "Повторить",
  "runtime.closeWithoutSave": "Закрыть приложение без сохранения? При повторном открытии проекта может потребоваться восстановление.",
  "runtime.closeFailed": "Не удалось закрыть окно. Повторите попытку.",
  "runtime.closeApplication": "Закрыть приложение",
  "runtime.lost": "Соединение с приложением потеряно.",
  "runtime.lostDetails": "Работа с проектом приостановлена. Закройте окно и откройте приложение снова. При повторном открытии проекта несохранённым изменениям может потребоваться восстановление."
};
