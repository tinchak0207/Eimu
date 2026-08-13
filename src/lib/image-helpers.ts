export const imageHelpers = {
  base64ToBlob: (base64Data: string, type = "image/png"): Blob => {
    const byteString = atob(base64Data);
    const arrayBuffer = new ArrayBuffer(byteString.length);
    const uint8Array = new Uint8Array(arrayBuffer);

    for (let i = 0; i < byteString.length; i++) {
      uint8Array[i] = byteString.charCodeAt(i);
    }

    return new Blob([uint8Array], { type });
  },

  generateImageFileName: (provider: string): string => {
    const uniqueId = Math.random().toString(36).substring(2, 8);
    return `${provider}-${uniqueId}`.replace(/[^a-z0-9-]/gi, "");
  },

  download: async (
    imageSource: string,
    provider: string
  ): Promise<void> => {
    const fileName = imageHelpers.generateImageFileName(provider);
    const blob = imageSource.startsWith("data:") || imageSource.startsWith("http") || imageSource.startsWith("blob:")
      ? await fetch(imageSource).then((response) => response.blob())
      : imageHelpers.base64ToBlob(imageSource);
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = `${fileName}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Revoke late: revoking immediately after click() cancels the download in
    // some browsers because the download is triggered asynchronously.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
  },

  formatModelId: (modelId: string): string => {
    return modelId.split("/").pop() || modelId;
  },
};
