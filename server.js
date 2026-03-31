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

// ============================================================
// 配置
// ============================================================
const CONFIG = {
    APP_ID: process.env.FEISHU_APP_ID || 'cli_a941923f1a611ceb',
    APP_SECRET: process.env.FEISHU_APP_SECRET || 'pu4EkjA8mEDKiuoQyBnHLwk8wYYzKUXs',
    BITABLE_IMAGES_TOKEN: process.env.BITABLE_IMAGES_TOKEN || 'XNAXbj5kDax01yseSaSczaQVnmd',
    TABLE_IMAGES: process.env.TABLE_IMAGES || 'tblUHoJzQqCX7C7c',
    BITABLE_RECORDS_TOKEN: process.env.BITABLE_RECORDS_TOKEN || 'JaC1b0c7UaBFr1sQvnCcEAUxnph',
    TABLE_RECORDS: process.env.TABLE_RECORDS || 'tblIIIZTH7SS1C2O',
    ADMIN_PASSWORD_HASH: crypto.createHash('sha256').update('a3481616244.').digest('hex'),
};

// ============================================================
// Token 缓存
// ============================================================
let tokenCache = { token: null, expiresAt: 0 };

async function getTenantToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) {
        return tokenCache.token;
    }
    const res = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: CONFIG.APP_ID,
        app_secret: CONFIG.APP_SECRET
    });
    tokenCache.token = res.data.tenant_access_token;
    tokenCache.expiresAt = Date.now() + res.data.expire * 1000;
    return tokenCache.token;
}

// ============================================================
// 管理员验证
// ============================================================
app.post('/api/admin-login', (req, res) => {
    const { password } = req.body;
    const hash = crypto.createHash('sha256').update(password || '').digest('hex');
    if (hash === CONFIG.ADMIN_PASSWORD_HASH) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: '密码错误' });
    }
});

// ============================================================
// 图片列表
// ============================================================
app.get('/api/images', async (req, res) => {
    try {
        const token = await getTenantToken();
        let allItems = [];
        let pageToken = '';

        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = response.data.data;
            allItems = allItems.concat(data.items || []);
            pageToken = data.has_more ? data.page_token : '';
        } while (pageToken);

        const images = allItems.map(item => {
            const f = item.fields;
            let imageUrl = '';
            // 优先用「预览图URL」显示
            if (f['预览图URL']) {
                imageUrl = f['预览图URL'];
            } else if (f['图片URL'] && typeof f['图片URL'] === 'string') {
                imageUrl = f['图片URL'];
            } else if (Array.isArray(f['图片URL']) && f['图片URL'].length > 0) {
                imageUrl = f['图片URL'][0].url || f['图片URL'][0].tmp_url || '';
            }

            const downloads = parseInt(f['下载次数'] || 0) || 0;
            let countries = [];
            if (f['已下载国家']) {
                countries = String(f['已下载国家']).split(',').map(s => s.trim()).filter(Boolean);
            }

            return {
                id: item.record_id,
                name: f['图片名称'] || '',
                url: imageUrl,
                rawUrl: f['图片URL'] || '',        // 原图URL（用于下载）
                previewUrl: f['预览图URL'] || '',  // 预览图URL
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

// ============================================================
// 代理下载（解决飞书临时URL跳转HTML问题，返回原文件）
// ============================================================
app.get('/api/download-image/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getTenantToken();

        // 获取图片URL
        const imgRes = await axios.get(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${id}`,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const f = imgRes.data.data.record.fields;
        let imageUrl = f['图片URL'] || '';
        let imageName = f['图片名称'] || '图片';

        // 如果是飞书临时URL，转为永久下载链接
        if (imageUrl.includes('tmp_download_url') || imageUrl.includes('feishu.cn')) {
            // 提取 file_token
            let fileToken = '';
            const match = imageUrl.match(/file\/([^/?#]+)/) || imageUrl.match(/media\/([^/?#]+)/);
            if (match) fileToken = match[1];

            if (fileToken) {
                // 使用飞书永久CDN下载接口
                imageUrl = `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/box/${fileToken}/?height=5120&width=2880&pwd=&x-tt-disable=1`;
            }
        }

        if (!imageUrl) {
            return res.status(404).send('图片不存在');
        }

        // 代理请求原图
        const imgResponse = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0'
            },
            maxRedirects: 5
        });

        const buffer = Buffer.from(imgResponse.data);
        const contentType = imgResponse.headers['content-type'] || 'image/jpeg';

        res.set({
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(imageName)}.jpg")`,
            'Content-Length': buffer.length,
            'Cache-Control': 'no-cache'
        });

        res.send(buffer);
    } catch (err) {
        console.error('代理下载失败:', err.message);
        res.status(500).send('下载失败');
    }
});

// ============================================================
// 下载记录列表
// ============================================================
app.get('/api/records', async (req, res) => {
    try {
        const token = await getTenantToken();
        let allItems = [];
        let pageToken = '';

        do {
            const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_RECORDS_TOKEN}/tables/${CONFIG.TABLE_RECORDS}/records?page_size=100${pageToken ? '&page_token=' + pageToken : ''}`;
            const response = await axios.get(url, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = response.data.data;
            allItems = allItems.concat(data.items || []);
            pageToken = data.has_more ? data.page_token : '';
        } while (pageToken);

        const records = allItems.map(item => {
            const f = item.fields;
            return {
                id: item.record_id,
                imageName: f['图片名称'] || '',
                name: f['下载人'] || '',
                date: f['上线时间'] || '',
                country: f['所属国家'] || '',
                downloadTime: f['下载时间'] || ''
            };
        }).filter(r => r.name).reverse();

        res.json({ success: true, data: records });
    } catch (err) {
        console.error('获取记录失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 提交下载记录
// ============================================================
app.post('/api/download', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { imageId, imageName, name, date, country } = req.body;

        if (!name || !date || !country || !imageId) {
            return res.status(400).json({ success: false, error: '缺少必填字段' });
        }

        const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

        // 写入下载记录
        await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_RECORDS_TOKEN}/tables/${CONFIG.TABLE_RECORDS}/records`,
            {
                fields: {
                    '图片名称': imageName,
                    '下载人': name,
                    '上线时间': date,
                    '所属国家': country,
                    '下载时间': now
                }
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        // 更新图片下载次数和已下载国家
        try {
            const imgRes = await axios.get(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${imageId}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            const fields = imgRes.data.data.record.fields;
            const currentDownloads = parseInt(fields['下载次数'] || 0) || 0;
            const currentCountries = fields['已下载国家']
                ? String(fields['已下载国家']).split(',').map(s => s.trim()).filter(Boolean)
                : [];
            if (!currentCountries.includes(country)) currentCountries.push(country);

            await axios.put(
                `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${imageId}`,
                {
                    fields: {
                        '下载次数': String(currentDownloads + 1),
                        '已下载国家': currentCountries.join(',')
                    }
                },
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );
        } catch (e) {
            console.warn('更新下载次数失败:', e.message);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('下载记录失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 上传图片
// ============================================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        const token = await getTenantToken();
        const file = req.file;
        const imageName = req.body.name || (file ? file.originalname.replace(/\.[^/.]+$/, '') : '未命名');
        const color = req.body.color || '';
        const theme = req.body.theme || '';
        const previewUrl = req.body.previewUrl || '';  // 预览图URL

        if (!file) return res.status(400).json({ success: false, error: '没有文件' });

        // 上传原图到飞书云盘
        const formData = new FormData();
        formData.append('file_name', file.originalname);
        formData.append('parent_type', 'bitable_file');
        formData.append('parent_node', CONFIG.BITABLE_IMAGES_TOKEN);
        formData.append('size', file.size.toString());
        formData.append('file', file.buffer, {
            filename: file.originalname,
            contentType: file.mimetype
        });

        const uploadRes = await axios.post(
            'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
            formData,
            { headers: { Authorization: `Bearer ${token}`, ...formData.getHeaders() } }
        );

        const fileToken = uploadRes.data.data?.file_token;
        if (!fileToken) throw new Error('上传失败，未获取到 file_token');

        // 获取永久CDN下载链接
        const cdnUrl = `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/box/${fileToken}/?height=5120&width=2880&pwd=&x-tt-disable=1`;

        // 写入多维表格（存原图CDN链接+预览图URL）
        await axios.post(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records`,
            {
                fields: {
                    '图片名称': imageName,
                    '图片URL': cdnUrl,          // 存原图CDN永久链接
                    '预览图URL': previewUrl || cdnUrl, // 预览图（默认用原图）
                    '颜色': color,
                    '主题': theme,
                    '下载次数': '0'
                }
            },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('上传失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 更新图片分类
// ============================================================
app.put('/api/images/:id', async (req, res) => {
    try {
        const token = await getTenantToken();
        const { id } = req.params;
        const { name, color, theme, previewUrl } = req.body;

        const fields = { '图片名称': name, '颜色': color, '主题': theme };
        if (previewUrl !== undefined) fields['预览图URL'] = previewUrl;

        await axios.put(
            `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.BITABLE_IMAGES_TOKEN}/tables/${CONFIG.TABLE_IMAGES}/records/${id}`,
            { fields },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('更新失败:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// 健康检查
// ============================================================
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ 飞书图片资源中心已启动: http://localhost:${PORT}`);
});
