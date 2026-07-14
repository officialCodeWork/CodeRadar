interface Photo {
  id: string;
  src: string;
}

export function ImageGallery({ photos }: { photos: Photo[] }) {
  return (
    <div>
      {photos.map((p) => (
        <img key={p.id} src={p.src} />
      ))}
    </div>
  );
}
