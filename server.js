const express = require('express');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const crypto = require('crypto');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
    CLOUDINARY_CLOUD: process.env.CLOUDINARY_CLOUD || 'dzyvenvyt',
    CLOUDINARY_KEY: process.env.CLOUDINARY_KEY || '233142572993625',
    CLOUDINARY_SECRET: process.env.CLOUDINARY_SECRET || 'CxfOYSwyt3E7K-OwzLRSFHFjzww',
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

// ── 上传到 Cloudinary ──
async function uploadToCloudinary(fileBuffer, mimetype, originalname) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sigStr = `timestamp=${ts}${CONFIG.CLOUDINARY_SECRET}`;
    const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

    const formData = new FormData();
    formData.append('file', fileBuffer, { filename: originalname, contentType: mimetype });
    formData.append('api_key', CONFIG.CLOUDINARY_KEY);
    formData.append('timestamp', ts);
    formData.append('signature', signature);

    const res = await axios.post(
        `https://api.cloudinary.com/v1_1/${CONFIG.CLOUDINARY_CLOUD}/image/upload`,
        formData,
        { headers: formData.getHeaders(), timeout: 60000 }
    );
    return res.data.secure_url || '';
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
            // 直接读文本字段存的 Cloudinary URL
            const previewUrl = f['预览图URL'] || '';
            const designUrl = f['设计图URL'] || previewUrl;
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

// ── 代理下载设计图（直接重定向到 Cloudinary URL）──
app.get('/api/download-design/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getTenantToken();

        const imgRes = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${id}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const f = imgRes.data.data.record.fields;
        const designUrl = f['设计图URL'] || f['预览图URL'] || '';
        const imageName = f['图片名称'] || '设计图';

        if (!designUrl) return res.status(404).send('设计图不存在');

        // 代理下载，保留原文件名
        const imgResponse = await axios.get(designUrl, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            maxRedirects: 5,
            timeout: 30000
        });

        const buffer = Buffer.from(imgResponse.data);
        const ct = imgResponse.headers['content-type'] || 'image/jpeg';
        const ext = ct.includes('png') ? '.png' : '.jpg';

        res.set({
            'Content-Type': ct,
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

// ── 删除下载记录 ──
app.delete('/api/records/:id', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { id } = req.params;
        await axios.delete(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_RECORDS_TOKEN}/tables/${CONFIG.TABLE_RECORDS}/records/${id}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('删除记录失败:', err.response?.data || err.message);
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

// ── 上传图片（上传到 Cloudinary，URL 存飞书表格）──
app.post('/api/upload', upload.fields([{ name: 'previewFile', maxCount: 1 }, { name: 'designFile', maxCount: 1 }]), async (req, res) => {
    try {
        const token = await getTenantToken();
        const { name, color, theme } = req.body;
        const previewFile = req.files?.previewFile?.[0];
        const designFile = req.files?.designFile?.[0];

        if (!previewFile && !designFile) return res.status(400).json({ success: false, error: '至少需要上传一张图片' });

        let previewUrl = '', designUrl = '';
        if (previewFile) previewUrl = await uploadToCloudinary(previewFile.buffer, previewFile.mimetype, previewFile.originalname);
        if (designFile) designUrl = await uploadToCloudinary(designFile.buffer, designFile.mimetype, designFile.originalname);

        const fields = {
            '图片名称': name || '未命名',
            '颜色': color || '',
            '主题': theme || '',
            '下载次数': '0',
            '预览图URL': previewUrl,
            '设计图URL': designUrl || previewUrl,
        };

        await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records`,
            { fields },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        res.json({ success: true, previewUrl, designUrl });
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
        const { name, theme } = req.body;
        await axios.put(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${id}`,
            { fields: { '图片名称': name, '主题': theme } },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('更新失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── 删除图片 ──
app.delete('/api/images/:id', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { id } = req.params;
        await axios.delete(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${id}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('删除失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});


// ── 系统设置 ──
app.get('/api/settings', async (req, res) => {
    try {
        const token = await getTenantToken();
        const listRes = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records?page_size=100`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const items = listRes.data.data?.items || [];
        const settingsItem = items.find(i => i.fields['图片名称'] === '__SYSTEM_SETTINGS__');
        if (!settingsItem) return res.json({ success: true, title: 'BIGO DESIGN', avatarUrl: '' });
        const f = settingsItem.fields;
        res.json({ success: true, title: f['主题'] || 'BIGO DESIGN', avatarUrl: f['设计图URL'] || '' });
    } catch (err) {
        console.error('获取设置失败:', err.message);
        res.json({ success: true, title: 'BIGO DESIGN', avatarUrl: '' });
    }
});

app.post('/api/settings', upload.single('avatar'), async (req, res) => {
    try {
        const token = await getTenantToken();
        const title = req.body?.title || '';
        
        // 查找设置记录
        const listRes = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records?page_size=100`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const items = listRes.data.data?.items || [];
        const settingsItem = items.find(i => i.fields['图片名称'] === '__SYSTEM_SETTINGS__');
        if (!settingsItem) return res.status(404).json({ success: false, error: '未找到设置记录' });
        
        const recordId = settingsItem.record_id;
        const fields = {};
        if (title) fields['主题'] = title;
        
        // 如果上传了新头像
        if (req.file) {
            const avatarUrl = await uploadToCloudinary(req.file.buffer, req.file.mimetype, req.file.originalname);
            fields['设计图URL'] = avatarUrl;
        }
        
        if (Object.keys(fields).length === 0) {
            return res.json({ success: true, avatarUrl: '' });
        }
        
        await axios.put(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${recordId}`,
            { fields },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        
        res.json({ success: true, avatarUrl: fields['设计图URL'] || '' });
    } catch (err) {
        console.error('保存设置失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ 飞书图片资源中心已启动: http://localhost:${PORT}`));
