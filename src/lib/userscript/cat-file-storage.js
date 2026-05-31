export function catFileStorage(action, details) {
  return new Promise((resolve, reject) => {
    CAT_fileStorage(action, {
      ...details,
      onload(data) {
        resolve(data);
      },
      onerror(error) {
        reject(error);
      },
    });
  });
}

export function openCatFileStorageConfig() {
  CAT_fileStorage("config");
}
