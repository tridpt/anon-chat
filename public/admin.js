const tokenForm = document.getElementById('token-form');
const tokenInput = document.getElementById('admin-token');
const clearTokenButton = document.getElementById('clear-token');
const statusFilter = document.getElementById('status-filter');
const refreshButton = document.getElementById('refresh-reports');
const reportsContainer = document.getElementById('reports');
const adminStatus = document.getElementById('admin-status');
const TOKEN_KEY = 'ghostchat-admin-token';

function getToken() {
    return window.sessionStorage.getItem(TOKEN_KEY) || '';
}

function setStatus(message, isError = false) {
    adminStatus.innerText = message;
    adminStatus.style.color = isError ? '#fda4af' : '';
}

function formatDate(value) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

async function api(path, options = {}) {
    const token = getToken();
    if (!token) throw new Error('Enter the ADMIN_TOKEN first.');

    const response = await fetch(path, {
        ...options,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers
        }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
}

function createReportCard(report) {
    const card = document.createElement('article');
    card.className = 'report-card';

    const topline = document.createElement('div');
    topline.className = 'report-topline';
    const title = document.createElement('div');
    const heading = document.createElement('h2');
    heading.innerText = `${report.reporter.alias} reported ${report.reportedUser.alias}`;
    const metadata = document.createElement('p');
    metadata.className = 'report-meta';
    metadata.innerText = `${formatDate(report.createdAt)} · ${report.id}`;
    title.append(heading, metadata);
    const badge = document.createElement('span');
    badge.className = `badge ${report.status}`;
    badge.innerText = report.status;
    topline.append(title, badge);

    const reason = document.createElement('p');
    reason.className = 'reason';
    reason.innerText = report.reason;

    const fields = document.createElement('div');
    fields.className = 'moderation-fields';
    const status = document.createElement('select');
    for (const value of ['new', 'reviewed', 'resolved']) {
        const option = document.createElement('option');
        option.value = value;
        option.innerText = value[0].toUpperCase() + value.slice(1);
        option.selected = value === report.status;
        status.appendChild(option);
    }
    const note = document.createElement('textarea');
    note.maxLength = 300;
    note.placeholder = 'Moderator note (optional)';
    note.value = report.moderationNote || '';
    const save = document.createElement('button');
    save.type = 'button';
    save.innerText = 'Save review';
    save.addEventListener('click', async () => {
        save.disabled = true;
        try {
            await api(`/api/admin/reports/${encodeURIComponent(report.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: status.value, moderationNote: note.value.trim() })
            });
            setStatus('Report review saved.');
            await loadReports();
        } catch (error) {
            setStatus(error.message, true);
            save.disabled = false;
        }
    });
    fields.append(status, note, save);
    card.append(topline, reason, fields);
    return card;
}

function renderReports(reports) {
    reportsContainer.innerHTML = '';
    if (!reports.length) {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.innerText = 'No reports match this filter.';
        reportsContainer.appendChild(empty);
        return;
    }

    reports.forEach(report => reportsContainer.appendChild(createReportCard(report)));
}

async function loadReports() {
    try {
        setStatus('Loading reports...');
        refreshButton.disabled = true;
        const query = statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : '';
        const { reports } = await api(`/api/admin/reports${query}`);
        renderReports(reports);
        setStatus(`${reports.length} report${reports.length === 1 ? '' : 's'} loaded.`);
    } catch (error) {
        reportsContainer.innerHTML = '';
        setStatus(error.message, true);
    } finally {
        refreshButton.disabled = false;
    }
}

tokenForm.addEventListener('submit', event => {
    event.preventDefault();
    window.sessionStorage.setItem(TOKEN_KEY, tokenInput.value);
    loadReports();
});

clearTokenButton.addEventListener('click', () => {
    window.sessionStorage.removeItem(TOKEN_KEY);
    tokenInput.value = '';
    reportsContainer.innerHTML = '';
    setStatus('Admin token cleared.');
});

refreshButton.addEventListener('click', loadReports);
statusFilter.addEventListener('change', loadReports);

tokenInput.value = getToken();
if (getToken()) loadReports();
