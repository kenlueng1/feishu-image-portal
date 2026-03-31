const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const crypto = require('crypto');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG = {
    APP_ID: process.env.FEISHU_APP_ID || 'cli_a941923f1a611ceb',
    APP_SECRET: process.env.FEISHU_APP_SECRET || 'pu4EkjA8mEDKiuoQyBnHLwk8wYYzKUXs',
    BITABLE_IMAGES_TOKEN: process.env.BITABLE_IMAGES_TOKEN || 'XNAXbj5kDax01yseSaSczaQVnmd',
    TABLE_IMAGES: process.env.TABLE_IMAGES || 'tblUHoJzQqCX7C7c',
    BITABLE_RECORDS_TOKEN: process.env.BITABLE_RECORDS_TOKEN || 'JaC1b0c7UaBFr1sQvnCcEAUxnph',
    TABLE_RECORDS: process.env.TABLE_RECORDS || 'tblIIIZTH7SS1C2O',
    ADMIN_PASSWORD_HASH: crypto.createHash('sha256').update('a3481616244.').digest('hex'),
};

let tokenCache = { token: null, expiresAt: 0 };

async function getTenantToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
    const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: CONFIG.APP_ID, app_secret: CONFIG.APP_SECRET
    });
    tokenCache.token = res.data.tenant_access_token;
    tokenCache.expiresAt = Date.now() + res.data.expire * 1000;
    return tokenCache.token;
}

app.post('/api/admin-login', (req, res) => {
    const hash = crypto.createHash('sha256').update(req.body.password || '').digest('hex');
    res.json(hash === CONFIG.ADMIN_PASSWORD_HASH ? { success: true } : { success: false });
});

// ── 图片列表 ──
app.get('/api/images', async (req, res) => {
    try {
        const token = await getTenantToken();
        let allItems = [], pageToken = '';
        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
            const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
            const data = response.data.data;
            allItems = allItems.concat(data.items || []);
            pageToken = data.has_more ? data.page_token : '';
        } while (pageToken);

        const images = allItems.map(item => {
            const f = item.fields;
            // 获取附件字段的URL
            function getAttachmentUrl(fieldValue) {
                if (!fieldValue || !Array.isArray(fieldValue) || fieldValue.length === 0) return '';
                const att = fieldValue[0];
                return att.url || att.temp_url || att.download_url || '';
            }
            const previewUrl = getAttachmentUrl(f['预览图']) || getAttachmentUrl(f['图片URL']);
            const designUrl = getAttachmentUrl(f['设计图']) || getAttachmentUrl(f['图片URL']) || previewUrl;
            const downloads = parseInt(f['下载次数'] || 0) || 0;
            let countries = [];
            if (f['已下载国家']) countries = String(f['已下载国家']).split(',').map(s => s.trim()).filter(Boolean);

            return {
                id: item.record_id,
                name: f['图片名称'] || '',
                url: previewUrl || designUrl,
                previewUrl,
                designUrl,
                color: f['颜色'] || '',
                theme: f['主题'] || '',
                downloads,
                countries
            };
        }).filter(img => img.name);

        res.json({ success: true, data: images });
    } catch (err) {
        console.error('获取图片失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 代理下载设计图 ──
app.get('/api/download-design/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getTenantToken();

        const imgRes = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${id}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const f = imgRes.data.data.record.fields;
        let imageUrl = '';
        // 优先设计图，其次预览图
        if (f['设计图'] && Array.isArray(f['设计图']) && f['设计图'].length > 0) {
            imageUrl = f['设计图'][0].url || f['设计图'][0].temp_url || '';
        }
        if (!imageUrl && f['预览图'] && Array.isArray(f['预览图']) && f['预览图'].length > 0) {
            imageUrl = f['预览图'][0].url || f['预览图'][0].temp_url || '';
        }
        if (!imageUrl && f['图片URL'] && Array.isArray(f['图片URL']) && f['图片URL'].length > 0) {
            imageUrl = f['图片URL'][0].url || f['图片URL'][0].temp_url || '';
        }
        let imageName = f['图片名称'] || '设计图';

        if (!imageUrl) return res.status(404).send('设计图不存在');

        // 代理下载
        const imgResponse = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            maxRedirects: 5
        });

        const buffer = Buffer.from(imgResponse.data);
        const contentType = imgResponse.headers['content-type'] || 'image/jpeg';
        const ext = contentType.includes('png') ? '.png' : '.jpg';

        res.set({
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(imageName + ext)}"`,
            'Content-Length': buffer.length,
            'Cache-Control': 'no-cache'
        });
        res.send(buffer);
    } catch (err) {
        console.error('代理下载失败:', err.message);
        res.status(500).send('下载失败');
    }
});

// ── 下载记录列表 ──
app.get('/api/records', async (req, res) => {
    try {
        const token = await getTenantToken();
        let allItems = [], pageToken = '';
        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_RECORDS_TOKEN}/tables/${CONFIG.TABLE_RECORDS}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
            const response = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
            allItems = allItems.concat(response.data.data.items || []);
            pageToken = response.data.data.has_more ? response.data.data.page_token : '';
        } while (pageToken);

        const records = allItems.map(item => {
            const f = item.fields;
            return { id: item.record_id, imageName: f['图片名称'] || '', name: f['下载人'] || '', date: f['上线时间'] || '', country: f['所属国家'] || '', downloadTime: f['下载时间'] || '' };
        }).filter(r => r.name).reverse();

        res.json({ success: true, data: records });
    } catch (err) {
        console.error('获取记录失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 提交下载记录 ──
app.post('/api/download', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { imageId, imageName, name, date, country } = req.body;
        if (!name || !date || !country || !imageId) return res.status(400).json({ success: false, error: '缺少必填字段' });
        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

        await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_RECORDS_TOKEN}/tables/${CONFIG.TABLE_RECORDS}/records`,
            { fields: { '图片名称': imageName, '下载人': name, '上线时间': date, '所属国家': country, '下载时间': now } },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        try {
            const imgRes = await axios.get(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${imageId}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const fields = imgRes.data.data.record.fields;
            const currentDownloads = parseInt(fields['下载次数'] || 0) || 0;
            const currentCountries = fields['已下载国家'] ? String(fields['已下载国家']).split(',').map(s => s.trim()).filter(Boolean) : [];
            if (!currentCountries.includes(country)) currentCountries.push(country);
            await axios.put(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${imageId}`,
                { fields: { '下载次数': String(currentDownloads + 1), '已下载国家': currentCountries.join(',') } },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );
        } catch (e) { console.warn('更新下载次数失败:', e.message); }

        res.json({ success: true });
    } catch (err) {
        console.error('下载记录失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 上传图片（预览图+设计图，存为飞书附件）──
app.post('/api/upload', upload.fields([{ name: 'previewFile', maxCount: 1 }, { name: 'designFile', maxCount: 1 }]), async (req, res) => {
    try {
        const token = await getTenantToken();
        const { name, color, theme } = req.body;
        const previewFile = req.files?.previewFile?.[0];
        const designFile = req.files?.designFile?.[0];

        if (!previewFile && !designFile) return res.status(400).json({ success: false, error: '至少需要上传一张图片' });

        // 上传文件到飞书云盘
        async function uploadToFeishu(file) {
            if (!file) return null;
            const formData = new FormData();
            formData.append('file_name', file.originalname);
            formData.append('parent_type', 'bitable_file');
            formData.append('parent_node', CONFIG.BITABLE_IMAGES_TOKEN);
            formData.append('size', file.size.toString());
            formData.append('file', file.buffer, { filename: file.originalname, contentType: file.mimetype });

            const upRes = await axios.post('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', formData, {
                headers: { Authorization: `Bearer ${token}`, ...formData.getHeaders() }
            });
            return upRes.data.data?.file_token || null;
        }

        const previewToken = await uploadToFeishu(previewFile);
        const designToken = await uploadToFeishu(designFile);

        // 构建字段
        const fields = {
            '图片名称': name || '未命名',
            '颜色': color || '',
            '主题': theme || '',
            '下载次数': '0'
        };
        if (previewToken) fields['预览图'] = [{ file_token: previewToken }];
        if (designToken) fields['设计图'] = [{ file_token: designToken }];
        // 兼容旧的「图片URL」字段
        if (!previewToken && !designToken && previewFile) fields['图片URL'] = previewFile.originalname;

        await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records`,
            { fields },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('上传失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 更新图片 ──
app.put('/api/images/:id', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { id } = req.params;
        const { name, color, theme } = req.body;
        await axios.put(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${id}`,
            { fields: { '图片名称': name, '颜色': color, '主题': theme } },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('更新失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 飞书图片资源中心已启动: http://localhost:${PORT}`));
