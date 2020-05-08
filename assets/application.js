$(function () {
    CodeMirror.extendMode( 'sql', { electricChars: ')' } );
    window.editor = CodeMirror.fromTextArea( $('#sql-input')[0], {
        mode: 'text/x-mariadb',
        theme: 'monokai',
        matchBrackets: true,
        lineNumbers: true
    });

    $('.btn-format').on('click', function (e) {
        e.preventDefault();
        editor.setValue(
            sqlFormatter.format(editor.getValue())
        );
    });

    $('.btn-clear').on('click', function (e) {
        e.preventDefault();
        editor.setValue('');
        editor.focus();
        $('.explain-output').hide();
        $('.tips').hide();
        window.history.replaceState({}, document.title, window.location.origin + window.location.pathname);
    });

    $('.schema-browser-container').on('click', '.schema-browser-btn', function (e) {
        e.preventDefault();
        $.ajax('/describe/' + $('#use-input').val()).then(results => {
            $('.schema-browser-content').html(results);

            $('.schema-browser-table-link').one('click', function (e) {
                e.preventDefault();
                $.ajax('/describe/' + $('#use-input').val() + '/' + $(this).data('table')).then(results => {
                    $('.schema-browser-content').html(results);
                });
            });
        });
    });
});
