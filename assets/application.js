$(function () {
    CodeMirror.extendMode( 'sql', { electricChars: ')' } );
    var editor = CodeMirror.fromTextArea( $('#sql-input')[0], {
        mode: 'text/x-mariadb',
        theme: 'monokai',
        matchBrackets: true,
        lineNumbers: true
    });
});
