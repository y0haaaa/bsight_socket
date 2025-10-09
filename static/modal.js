const dropdown = document.getElementById('wssDropdown');
let activeInput = null;


document.querySelectorAll('.wss-input').forEach(input => {
  input.addEventListener('click', (e) => {
    e.stopPropagation();
    activeInput = input;

    
    const rect = input.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom + window.scrollY + 4}px`;
    dropdown.style.left = `${rect.left + window.scrollX}px`;
    dropdown.style.width = `${rect.width}px`;

    dropdown.classList.add('show');
  });
});

// Обработка выбора опции
dropdown.querySelectorAll('.option').forEach(opt => {
  opt.addEventListener('click', () => {
    if (!activeInput) return;

    const url = opt.dataset.url;

    activeInput.value = url;

    dropdown.classList.remove('show');
    activeInput = null;
  });
});

// Клик вне области — закрываем
document.addEventListener('click', (e) => {
  if (!dropdown.contains(e.target)) {
    dropdown.classList.remove('show');
    activeInput = null;
  }
});