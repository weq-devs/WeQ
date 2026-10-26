export { trpc } from './trpc.stub';
const entries = [
  { name: '课程讲义', isDir: true, fileSize: 0 },
  { name: '数据结构课程讲义与期末复习资料（完整整理版）.pdf', fileSize: 8257536 },
  { name: '项目源码.zip', fileSize: 23068672 },
  { name: '实验记录.md', fileSize: 4096 },
  { name: '演示视频.mp4', fileSize: 134217728 },
  { name: '等待上传的补充材料.docx', fileSize: 32768, status: 1 },
];
export const client = {
  account: {
    flashListFiles: {
      query: async () => ({
        files: entries.map((file, index) => ({
          status: 2,
          ...file,
          fileId: String(index),
          filesetId: 'fixture',
          physicalId: `physical-${index}`,
        })),
      }),
    },
    flashStartDownloads: { mutate: async () => ({ started: 5, errors: [] }) },
  },
};
