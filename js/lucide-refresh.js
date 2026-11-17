(function () {
    function refreshLucideIcons() {
        if (typeof lucide === 'undefined' || typeof lucide.createIcons !== 'function') return;
        lucide.createIcons({
            attrs: {
                class: 'lucide-icon',
                'stroke-width': 2,
            },
        });
    }
    window.refreshLucideIcons = refreshLucideIcons;
})();
