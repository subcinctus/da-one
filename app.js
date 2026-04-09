const uploadInput = document.getElementById('cat-upload-input');
const galleryGrid = document.getElementById('gallery-grid');
const photoCount = document.getElementById('photo-count');
const clearGalleryButton = document.getElementById('clear-gallery');
const template = document.getElementById('gallery-item-template');

const state = {
  photos: []
};

function formatPhotoCount(count) {
  return `${count} photo${count === 1 ? '' : 's'}`;
}

function renderEmptyState() {
  galleryGrid.innerHTML = '<p class="empty-state">No cat photos yet. Add one above to get started.</p>';
}

function updatePhotoCount() {
  photoCount.textContent = formatPhotoCount(state.photos.length);
}

function removePhoto(index) {
  const [removed] = state.photos.splice(index, 1);

  if (removed) {
    URL.revokeObjectURL(removed.url);
  }

  renderGallery();
}

function createPhotoItem(photo, index) {
  const item = template.content.firstElementChild.cloneNode(true);
  const image = item.querySelector('img');
  const removeButton = item.querySelector('.photo__remove');

  image.src = photo.url;
  image.alt = `Cat photo ${index + 1}`;
  removeButton.addEventListener('click', () => removePhoto(index));

  return item;
}

function renderGallery() {
  galleryGrid.innerHTML = '';
  updatePhotoCount();

  if (state.photos.length === 0) {
    renderEmptyState();
    return;
  }

  state.photos.forEach((photo, index) => {
    galleryGrid.append(createPhotoItem(photo, index));
  });
}

function addPhotos(fileList) {
  const acceptedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  const incomingFiles = Array.from(fileList).filter((file) => acceptedTypes.includes(file.type));

  incomingFiles.forEach((file) => {
    state.photos.unshift({
      url: URL.createObjectURL(file),
      name: file.name
    });
  });

  renderGallery();
}

uploadInput.addEventListener('change', (event) => {
  addPhotos(event.target.files);
  uploadInput.value = '';
});

clearGalleryButton.addEventListener('click', () => {
  state.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
  state.photos = [];
  renderGallery();
});

renderGallery();
